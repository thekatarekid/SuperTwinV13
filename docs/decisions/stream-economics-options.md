# Stream economics: options and tradeoffs

Not a plan. Options with numbers attached, so you can pick.

Every claim is marked **CONFIRMED** (direct query / direct read) or **ESTIMATE** (method stated).
Source of truth for money is the `runs` table in `~/SuperTwinV13/supertwinv13.db`, read-only.
The `traces` JSONL under-reports by ~8% (1,508 runs have no trace row), so trace-derived
totals below are scaled to the ledger and marked where that happens.

Dollar figures are Haiku list-price equivalents. The real currency is tokens against your
subscription allowance.

---

## 1) The three numbers that matter

### Number 1 — events per stream, by source

| source | events | streams | events/stream | median | singleton streams | status |
|---|---:|---:|---:|---:|---:|---|
| **browser** | 3,452 | 2,446 | **1.41** | 1 | **2,220 (90.8%)** | CONFIRMED |
| **screen / AX** | 25 | 10 | **2.50** | 2 | 3 (30%) | CONFIRMED (11.8-min real session) |
| **WhatsApp** (lifetime, V11 corpus) | 7,278 | 133 | **54.7** | 3 | 41 (31%) | CONFIRMED |
| **WhatsApp** (regrouped into V13's 5-min windows) | 7,278 | 2,196 bundles | **3.31** | 1 | 1,148 bundles (52%) | CONFIRMED |

Three corrections to the working assumptions:

- **Screen has already run.** There are 25 real `screen.snapshot` events across 10 streams
  in the live DB (2026-08-29 04:05→04:16Z). Screen is not an estimate any more.
- **WhatsApp is not 10× better than browser under V13.** Its *lifetime* density is 54.7,
  but V13 bundles per stream per 5-minute window (`dispatch.ts:68` `windowMs: 5*60_000`,
  `dispatch.ts:282-288` group-by-stream). Replay the real corpus through that rule and it
  collapses to **3.31 events per call** — only 2.3× browser, not 10×.
- **V11 got 14.4 events per call** on the same messages (506 `extraction:extract` runs over
  7,278 events, CONFIRMED from `~/SuperTwin/supertwin.db`) because it batched per ingest
  wave, not per 5-minute window.

### Number 2 — streams per model call: exactly **one**, always

CONFIRMED three ways:
- `dispatch.ts:282-288` groups by `stream_id ?? stream_key`; `dispatch.ts:302-373` emits one
  `DeltaBundle` inside that loop; `DeltaBundle` carries scalar `streamId`/`streamKey`
  (`dispatch.ts:93-114`) — there is no field for a second stream.
- `consumer.ts:5`: "pack (§6.4) → ONE Orient call".
- Prompt text in the real traces: *"Turn one stream's new events into episodes"*.

And no call mixes sources. Not by policy — by key namespace. Browser keys are
`browser:<b>:chain:<hash>`, WhatsApp keys are JIDs, screen keys are `bundleId¦docKey`.
They cannot collide, so one group is always one source. **Mixing sources today is
structurally impossible, not merely disabled.**

This is also what the spec asks for. §6.3.1: *"streams never share a prompt"*.
§8.1: *"ORIENT (per stream-bundle)"*. So the expensive choice is not the one-stream rule —
it is the **stream key definition**, which came from the build plan
(`SuperTwinV13_Product_V2_Build.md:105`, "tab id + referrer + 30-min gap") for a data source
that has no tab id. `chains.ts:5-7` admits this in its own header.

Measured consequence during the incident: 15,181 traced browser Orient calls hit only
**2,346 distinct stream keys — 6.47 calls per stream, max 14** (CONFIRMED). Cause at
`dispatch.ts:626-635`: `assignSlots` caps the planned path at 4 bundles/window, then
`for (const bundle of admittedOrphans) route(bundle)` routes the orphan scan with **no slot
cap at all**. Verified by reading the code above.

### Number 3 — content vs overhead in one call

CONFIRMED, `runs` where `kind='orient.v6'`, n=16,654:

| | tokens |
|---|---:|
| cache_read (avg) | 18,293 |
| cache_create (avg) | 11,166 |
| fresh input (avg) | 3 |
| **total input** | **29,462** |
| output (avg) | 338 |
| **cost/call (avg)** | **$0.02859** |
| **total, orient.v6** | **16,654 calls · $476.13** |

The `[NEW BUNDLE]` block — the thing actually being understood — is **217 chars ≈ 71 tokens**
at the median, 458 chars ≈ 150 tokens at the mean (CONFIRMED over 15,183 traced browser calls).

> **Content is 0.24% of the call at the median, 0.51% at the mean.
> 99.5–99.8% of every Orient call is scaffolding.**

Cost model derived from the same data (CONFIRMED by binning traced calls by event count):

> **$0.0283 fixed per call + ~$0.0002 per extra event.**
> Cost is a function of *call count*. Events are nearly free.

A 1-event bundle costs $0.0283; a 20-event bundle costs $0.0456. Twenty times the content
for 1.6× the money.

---

## 2) Problem 1 — stream design

### Why browser shatters into 1.4-event streams

`chains.ts:40-67` (read directly). A visit joins its parent's chain only if
`referrerVisitId` resolves **and** the parent is in the same read batch **and** the gap is
≤30 min. Otherwise it roots a new stream. Four independent breakers, all CONFIRMED:

1. **No referrer at all — dominant.** 2,005 of 3,452 events (58.1%) have
   `payload.referrer = null`. Of those: `reload` 663 (page reloads alone are 19% of all
   browsing and every one is a singleton), `link` 742 (new-tab opens, restored tabs,
   expired parent rows), plus `typed`, `bookmark`, `generated`, `start_page`.
2. **The 30-min gap on the referrer.** Of the 1,447 visits that *did* carry a referrer,
   ~431 still rooted new chains (ESTIMATE: chains minus rootless visits).
3. **The read batch is the referrer horizon.** `chains.ts:42-43` builds `byId` only from the
   visits passed in; `watcher.ts:174-179` passes only this poll's rows. At a 60-second poll
   interval, live browsing chains are cut at almost every poll boundary.
4. **Safari is structurally worse.** `history-db.ts:224` uses `redirect_source`, so only
   redirect hops chain. Every ordinary Safari link click is its own stream.

Only redirects survive: 603 `redirect` visits, **zero** with a null referrer — 100% joined.

The distribution is not "1.4 events per stream." It is **91% singletons plus a thin tail**
(max 46). 64% of all browser events live alone in a stream and can never be understood in
company.

### Will screen repeat it? Partly — it is a third shape, and the key destroys the good half

Screen's key is `bundleId¦docKey`. Measured over the real 11.8-minute session (CONFIRMED):

- Finder fragmented into **4 streams for 8 events** (`¦`, `¦Applications`, `¦adityakatare`,
  `¦SuperTwinV13`). One "looking for a file" session, four Orient calls.
- System Settings fragmented into **3 streams** while toggling one permission.
- A parked Brave tab produced **5 events in one stream** — the good case.
- Empty `docKey` (`Live.swift:167-169` falls back to `""`) is simultaneously a junk bucket
  (unrelated windows merge) and a splitter (titled windows of the same app split off).

So screen is **bimodal**: parked attention (video, meeting, one editor file) is dense and
WhatsApp-shaped; hopping attention (tabs, folders, settings panes) is sparse and
browser-shaped. Ordinary GUI use is mostly hopping, and `bundleId¦docKey` cuts a new stream
at exactly the moment attention moves. Measured result: **2.08 events per bundle** —
browser-shaped.

Rate: 2.13 captures/min measured → ~61 bundles/hour → **$1.82 per hour of ordinary GUI use**.
A realistic 8-hour day is **~340 bundles ≈ $10/day ≈ $220/month from screen alone**
(ESTIMATE: 2h coding at 18 bundles/hr + 2h meetings at 30 + 4h mixed at the measured 61).

Two brakes that will not save it, both CONFIRMED by reading the code:
- `isLowSignal` (`dispatch.ts:150-157`) returns false the moment any text matches
  `ENTITY_RE` (`/\d{2,}|https?:\/\/|www\.|@\w|[₹$€£]|\b[A-Z][a-z]+\s+[A-Z][a-z]+\b|\?/`).
  Screen captures average 1,494 chars full of URLs and Title Case. **No screen bundle can
  ever be deferred.** Browser visits carry a URL by definition — same. The one source the
  brake catches is WhatsApp, at 44 chars/event, which least needs it.
- Deferral is also gated on `lane === "live"` (`dispatch.ts:308`), so the 2,436-stream
  backfill had no brake at all.
- Slots throttle concurrency, not production (`priority.ts:134-140` admits all live work
  unconditionally). Over-produced windows queue into later windows. **Cost is deferred,
  never avoided** — and the ≤10-min freshness target breaks with it.

### Candidate approaches

All arithmetic on the real corpus: 3,452 events, 2,436 streams, 80 days, 143 domains.
Reference points: actual browser Orient spend ≈ **$471** (ESTIMATE: 98.9% browser share of
traced Orient calls, scaled to the $476.13 ledger total). One clean pass at today's keys with
the orphan bug fixed = 2,436 calls ≈ **$69**.

**A0 — cap the orphan path (`dispatch.ts:635`).** Not a design choice, a bug.
Measured 6.47× call multiplication. **$471 → $69. 6.5× for a slot check.** No quality change
whatsoever. Every other option below multiplies on top of this one.

**A1 — coarser browser stream keys.** Same events, different derivation at `chains.ts:58`.
Stream counts are CONFIRMED by direct re-keying query against the live DB:

| keying | streams | ev/call | cost | vs today's key |
|---|---:|---:|---:|---:|
| chain (today) | 2,436 | 1.4 | $69 | 1.0× |
| domain + hour | 1,319 | 2.6 | $38 | 1.8× |
| **domain + day** | **643** | **5.4** | **$19** | **3.8×** |
| global 30-min session | 656 | 5.3 | $19 | 3.7× |
| domain, all-time | 143 | 24.1 | $4.7 | 15× |
| day, all browsing | 80 | 43.2 | $2.9 | 24× |

- **Quality risk.** The stream is the unit of episode identity and thread history. Per-day
  keys hand one prompt hotstar + gmail + docs + netflix and rely on the model's own topic
  split. Per-domain-all-time destroys time separation — a March trip search and an August one
  land in one thread. **Per-domain-per-day is the sweet spot**: it collapses the 663 reload
  singletons and the same-site link singletons (pure waste, not lost signal) while keeping one
  call topically about one site on one day. The referrer stays on the payload, so navigation
  structure is visible to the model; it just stops being the billing unit.
- **What it breaks.** Stream keys are append-idempotency and cursor identity
  (`chains.ts:9-12`, `dispatch.ts:447`). Every existing browser stream is orphaned — needs a
  migration or a clean re-import. `streams.category`, `engagement_score`, `cursor_rowid`
  re-base. Dwell inference (`chains.ts:72-79`) changes which visit inherits which gap.
- **Note:** do NOT propose "chain harder." Chaining is already implemented and it produced
  91% singletons. Referrers are absent for exactly the cases that matter.

**A2 — screen: focus-session key instead of document key.** `bundleId` + a session id that
rolls on an inactivity gap, reusing the `CHAIN_GAP_MS` pattern already in `chains.ts:18`.
Stream = "the 40 minutes in VS Code", not "each file". On the measured session: 10 streams →
~4, 12 bundles → ~6, ratio **2.08 → ~4.2**. Under the browsing persona it takes 90 URL-streams
down to 1–3 Chrome sessions (ESTIMATE, 1.7 → ~15 ev/bundle).
Weaker fallback: **`bundleId` alone** — measured 10 streams → 5, ratio → **3.6**, one line of
code, but Chrome-with-40-tabs becomes one undifferentiated blob.
Cheap independent add-ons: fix the `""` docKey fallback (`Live.swift:167-169`), and add a
minimum new-chars floor on switch-triggered captures — 64% of measured events were
`window_switch`, some carrying **2–3 characters** of new text.

**A3 — WhatsApp: engagement-tiered windows.** 13 streams hold 85% of lifetime volume; 85
streams have ≤5 events ever. Give hot threads the 5-min window (they already hit 6–20
ev/bundle) and put the tail on a daily window (12.23 ev/bundle measured). Expected 2,196 →
roughly 500–700 bundles on the same corpus. Also make `isLowSignal` count-aware, not only
char-aware — the `INTENT_RE` at `dispatch.ts:130-132` is already the right test for
"dispatch this tiny bundle now."
- **What it breaks:** latency on cold threads. Acceptable — that is what the tiering is for.

**A4 — many streams per call (batching).** 30 tiny streams per call: 2,436 → 82 calls ≈ $4.
- **Cost:** contradicts spec §6.3.1 verbatim, and touches the write path — `DeltaBundle`
  scalars (`dispatch.ts:93-97`), `commit.ts:247,263,323,364,390` binding every episode to one
  `streamId`, `packer/history.ts:62,71,159` scoping by `stream_id = ?`, `markDispatched`
  advancing one cursor (`dispatch.ts:447`). Needs per-block attribution in the Orient schema
  and a per-stream commit fan-out.
- **Quality risk:** the spec's stated reason is real — 30 unrelated streams in one prompt
  invites invented cross-stream episodes.
- **Verdict: A0+A1 get most of the win with none of this. Reach for A4 only for the residual
  singleton tail afterwards.**

---

## 3) Problem 2 — prompt overhead

### Block-by-block, measured over the 15,183 traced browser Orient calls

| block | mean chars | median | est. tok | note |
|---|---:|---:|---:|---|
| Claude Code default system prompt + built-in tool schemas | — | — | **18,483** | constant `cache_read`, not ours |
| CLI-injected attachments (skills, MCP tool names, env) | ~23,167 | — | **~7,899** | fixed `cache_create` intercept |
| our `orient.v6` system prompt — copy 1 (`--append-system-prompt`) | 4,605 | — | 1,151 | |
| our `orient.v6` system prompt — copy 2 (head of stdin) | 4,605 | — | 1,151 | deliberate duplicate |
| `[CROSS-SOURCE]` | 273.6 | 202 | ~70 | largest packed block after the bundle |
| `[STREAM]` | 112.0 | 112 | ~30 | |
| `[BAND POLICY]` | 100.8 | 123 | ~30 | |
| `[BAND]/[MODE]` | 40.0 | 40 | ~10 | |
| `[CANDIDATE SPACES]` | 28.0 | 26 | ~7 | always `(none)` — 4 SQL queries + an embedding call to produce it |
| `[ROSTER]` | 25.0 | 25 | ~6 | always `(none resolved)` for browser |
| `[THREAD HISTORY]` | 24.0 | 24 | ~6 | always `(none)`; code path still runs a 40-row scan |
| `[EPISODES here]` | 23.0 | 23 | ~6 | always `(none)` |
| `[RECENT CONTEXT]`, `[PREDECESSOR]` | 0.0 | 0 | 0 | never fired |
| **`[NEW BUNDLE]`** | **458.1** | **217** | **~71 (median)** | **the actual content** |
| **total input** | | | **29,462** | CONFIRMED from `runs` |

Six of eleven packed blocks are literally the word `(none)`. The roster and the thread-history
elastic 20–40 rule cost **zero** on this data — they are latent costs for chat, not the
browser problem. Do not spend effort there first.

### The Claude Code CLI's own fixed overhead — a separate line

Evidence that the 18,483 is not ours: `cache_read` is **min = max = 18,483** for `critic.v4`
(system prompt 2,081 chars), `decide` (8,665 chars), `extract`, and `followup` — CONFIRMED by
query. A prefix that does not move while our prompt varies 2k→8.6k chars is by construction
not our prompt.

What we actually put on the wire (median browser call): `2 × 4,605 + 877 = 10,087` chars
≈ **2,589 tokens**. What was billed: **29,462**.
**Gap = ~26,900 tokens per call ≈ $0.019/call ≈ $310 of the $476 Orient spend** (ESTIMATE:
gap × ledger call count).

The `digest` pass is the sanity floor: it sends ~2,160 chars of our content and is billed
~27,800 input tokens. **There is a ~27,000-token floor no matter what you ask.**

Injected attachments, sampled over 400 of the runaway's session transcripts (CONFIRMED):
`skill_listing` 11,865 chars mean (present in 386/400), `deferred_tools_delta` 7,230 chars
(386/400 — the names of your Gmail, Calendar, Drive, Linear, Figma tools), `agent_listing`
2,788, `hook_success` 891, `mcp_instructions` 267. Your personal connector tool names were
shipped to Haiku ~16,000 times to classify Netflix visits. That is a privacy issue as much as
a cost one.

### The flags the code says do not exist — I checked the binary myself

`cli.ts:88` asserts *"The CLI exposes no `--system-prompt` replace flag"* and `index.ts:34-37`
asserts there is no `--append-system-prompt-file`. **Both comments are stale.** Extracted with
`strings` from `~/.local/share/claude/versions/2.1.251` (no process spawned) — all CONFIRMED
present:

- `--system-prompt` / `--system-prompt-file` — *replaces* the default. Corroborated by the help
  for `--exclude-dynamic-system-prompt-sections`: *"Only applies with the default system
  prompt (ignored with `--system-prompt`)."*
- `--tools <tools...>` — *"Specify the list of available tools from the built-in set. Use ""
  to disable all tools."* This removes definitions. `--allowedTools`/`--disallowedTools`,
  which the repo does use, are permission gates only — the schemas still ship.
- `--strict-mcp-config` — *"Only use MCP servers from `--mcp-config`, ignoring all other MCP
  configurations."* Kills the connector-name injection.
- `--smol` — *"Minimal mode: skip hooks, LSP, plugin sync, attribution, auto-memory,
  background prefetches, keychain reads, and CLAUDE.md auto-discovery."*
- `--max-budget-usd <amount>` — a hard per-invocation spend cap. Nothing on this path has one.

`--setting-sources ""` did suppress CLAUDE.md (that saving is real). It does not touch MCP or
skills.

### Options, ranked by tokens saved per unit of risk

| # | option | per-call after | risk |
|---|---|---:|---|
| **B1** | `--system-prompt-file` + `--tools ""` + `--strict-mcp-config` (+ `--smol`), then delete the double-send at `index.ts:189-192` | **~$0.0058 (−80%)** | low; ~15 lines in one file, but it removes Claude Code's default instructions the passes were accidentally tuned against — needs one eval run per pass |
| **B2** | don't call the model at all for Cat-2 browsing (domain table + digest row) | **$0** on ~99% of calls | loses incidental Cat-2 signal; needs a category policy you must agree to |
| **B3** | batch bundles (up to 25 events / one stream-day) | amortizes the residual floor | useless until stream keying is fixed — 2,436 one-visit streams have nothing to batch |
| **B4** | strip tracking params, drop `[CROSS-SOURCE]` for Cat-2, omit `(none)` blocks | ~−1% tokens | take this for retrieval quality, not money: ~75% of a Netflix bundle's bytes are `?tctx=` base64, which also poisons the FTS lane (`spaces.ts:53-66`) |
| **B5** | cap the roster; a short Cat-2 prompt variant | ~−$0.002 | every v6 rule closed a named eval failure — prefer two prompt variants over deleting rules |
| **B6** | cache-friendly ordering | — | a consequence of B1, not a separate lever: the 7,899-token intercept is byte-identical content re-written to a 1-hour cache on every call and never read back, because each call opens a fresh CLI session (30,343 session files for one day) |

### Is the agent harness even the right transport for a one-shot classification call?

State it plainly: **no.**

Orient is a stateless, single-turn, JSON-out classification. It uses no tools, no filesystem,
no memory, no session. It runs with `--max-turns 1`, `MAX_THINKING_TOKENS=0`, `--allowedTools ""`
and `cwd = tmpdir()` — the code is already trying to strip the agent down to a bare model call
by starvation. What it gets instead is a ~27,000-token floor, an agent system prompt, built-in
tool schemas, a skill catalogue, and your connector list, once per call, 16,654 times.

Three transports, honestly compared:

1. **Today — CLI with append.** ~29,500 in / 338 out. $0.0286.
2. **CLI, correctly flagged (B1).** ~1,940 in / 338 out. **~$0.0058.** Keeps subscription
   billing, keeps the local-first "no API key" property, ~15 lines of change. If the now-stable
   prefix actually caches across calls, ~$0.0024.
3. **Messages API direct.** One HTTPS POST, `system` + `messages`, ~1,450 input tokens. No
   session file, no attachments, no harness. **The correct transport on the merits** — but it
   needs an API key, moves billing off the subscription, and is a real architectural change to
   the provider layer.

The honest read: option 2 recovers ~80% of the waste while keeping the local-first property.
Option 3 is what you would design from scratch. The reason to consider 3 anyway is that the
27,000-token floor is set by a tool you do not control and can change under you at any CLI
release — which is exactly how the stale comments in `cli.ts:88` got stale.

**Free regardless of which you pick: add `--max-budget-usd`.** It would not have prevented the
runaway, but it would have capped what each of 16,654 spawns could individually spend.

---

## 4) Problem 3 — opt-in connect flows

### What auto-starts today (CONFIRMED, `worker/src/index.ts`)

| line | starts | consent check |
|---|---|---|
| :65-83 | WhatsApp adapter + `connect()` (spawns the daemon) | none |
| :97 | `startBrowserWatcher` | none |
| :110 | `startScreenWatcher` | none |
| :160 | brain consumer + dispatcher (the paying lane) | none |

`watcher.ts:132`: `const floor = opts.sinceMs ?? this.now() - 90 * DAY_MS`, and `start()` fires
`queueMicrotask(() => this.pollSafe())` — an immediate first poll. **The default *is* the
90-day import.**

Three further facts worth knowing:
- `sources.connected_at` exists (`0020_v2_core.sql:62`) and is referenced by **nothing but the
  migration**. All 5 rows: `enabled=1`, `connected_at=NULL`. The consent column was built and
  never wired.
- `discoverProfiles()` (`watcher.ts:57-85`) is a hardcoded 3-entry, `Default`-profile-only list.
  **Brave is not in it** — 4,650 visits invisible. `Profile 1`, `Profile 2` are never read.
  Safari is listed via `existsSync` but reads fail `EPERM` (needs Full Disk Access), silently
  swallowed at `watcher.ts:171-174`.
- `capture.domain_blocklist`, `capture.app_blocklist` and `pausedKey("browser")` are **written
  by settings and read by nothing**. Pausing browser capture in Settings does nothing.

### The Browser "connect" card is cosmetic w.r.t. capture

`BrowserLibrary.tsx:76-105` "Import from Chrome" calls `startImportFromChrome()` — that opens
*Chromium's own import UI inside the SuperTwin Browser* to seed the agent browser's profile.
It has nothing to do with the history watcher. Worse, the card only renders when
`captured === false`, and the watcher's first poll fires within microseconds of boot — so the
branch is **unreachable in practice**. WhatsApp's pair→range flow (`WhatsAppLibrary.tsx:196-262`)
is the only real connect flow in the product; Screen's "Open System Settings" is real and
correctly shaped.

### What we can honestly show before the user commits

Pre-counting is cheap and safe — measured on this machine, reusing `withHistoryCopy`
(`history-db.ts:66-92`), no import, no model call:

```
chrome/Default  10.2MB  copy 8ms  all-10-range COUNTs 2ms  3,337 visits  back to 2026-05-31
brave/Default    4.2MB  copy 9ms  all-10-range COUNTs 1ms  4,650 visits  4,074 bookmarks
safari                  EPERM — needs Full Disk Access
```

Chain counts (= Orient calls) are also computable pre-import by replaying `assignChains` over
the copied DB in ~3ms. Validation that the simulation is faithful: Chrome at 180 days →
**2,436 chains**, exactly the stream count the real import produced.

| Chrome range | Orient calls | input tokens | $ equiv | wall clock @48 calls/hr |
|---|---:|---:|---:|---|
| 1 day | 6 | 0.18M | $0.17 | 8 min |
| 3 days | 39 | 1.15M | $1.11 | 49 min |
| **7 days** | **103** | **3.0M** | **$2.94** | **2.1 h** |
| 30 days | 667 | 19.7M | $19.07 | 13.9 h |
| 90 days | 2,335 | 68.8M | $66.76 | **48.6 h** |
| everything | 2,436 | 71.8M | $69.65 | 50.8 h |

(Calls CONFIRMED by simulation; tokens/cost ESTIMATE = calls × 29,462 × $0.02859. Wall clock
from the shipped `slots: 4` per `windowMs: 5min` = 48 calls/hour.)

Brave "everything" adds 2,869 calls / 84.5M tokens / 59.8 h. Chrome 90d + Brave everything is
**153M input tokens and four days of grinding**, for one click nobody made.

Three honesty rules for that card:
1. **Tokens first, dollars second.** These draw on the subscription allowance. "≈69M input
   tokens, roughly 30% of a weekly allowance" is true; "$66.76" is an analogy.
2. **Quote a range, not a point.** Critic adds up to +88% per committed tick ($0.0251 on top of
   $0.0286) but ran on only 5.8% of Orients here. Show a floor and a ceiling.
3. **Say the wall clock.** 90 days is two days of grinding. The only way it finishes in an hour
   is the uncapped path that caused the incident.

**WhatsApp cannot be pre-counted.** History arrives as phone-pushed sync payloads;
`source.whatsapp.history_depth` is a *post*-import verdict (currently `{"chats":0,...,"verdict":"unknown"}`).
Say so rather than inventing a number.

**Blocker for post-hoc truth-telling:** `runs.pass` and `runs.origin` are **NULL for all 18,031
rows** (CONFIRMED). You cannot answer "what did the browser source cost me" until `origin` is
stamped in `brain/llm.ts`. Don't gate the estimate feature on it — ship a constant
(29,462 in / 338 out) and switch to the machine's rolling median after ~50 runs.

### Flow shape per source

- **Browser** — enumerate profiles (10ms each) → per-profile checkboxes, history and bookmarks
  independent → range picker with **live counts beside each option** → confirm with the total
  spelled out in tokens → import with a live counter and a Stop that actually stops and keeps
  partial work. Default: **7 days, pre-selected**; all profiles **unchecked**. Reason: 7 days is
  the largest range under ~3M tokens that finishes inside a working day. The cliff is between 7
  and 30 (6.5× jump), so the default belongs on the cheap side of it. Anything ≥30 days gets a
  second confirm.
- **WhatsApp** — keep the existing pair→range flow. Two fixes: extend `IMPORT_RANGES`
  (`src/lib/api.ts:361-371` ships 9 of the 12 values the worker already accepts in
  `adapters/types.ts:32-45` — missing `3d`, `3y`, `4y`), and don't ingest live messages between
  pairing and range-confirm.
- **Screen** — permission-only, no range, as today. Two fixes: persist pause to `app_state` and
  seed `adapter.paused` from it at boot (`adapter.ts:171` is in-memory, so pause dies on
  restart), and require an explicit "Start capturing" after the grant.

### Disconnect semantics — two actions, never one button

- **"Stop capturing"** — clear `connected_at`, stop the watcher, keep the data. Default.
- **"Disconnect and delete everything"** — destructive, separate, second click.

**The delete path for this does not exist, and the nearest thing lies.** `resetSourceData()`
(`db/ingest.ts:2179-2197`) deletes only `events`, `streams`, `channels`, `actors`, orphan
`people`. It leaves episodes, claims, claim_versions, tasks, content_digests and decisions
derived from the deleted events standing. The correct generic cascade exists —
`hardDeleteEvents()` (`delete-cascade.ts:107`) — but its only wrapper is `deleteScreenSpan()`.
A source-level delete must route through `hardDeleteEvents(SELECT id FROM events WHERE source_type=?)`.

**Per-profile disconnect is not expressible today.** Stream keys carry the browser but not the
profile (`chains.ts:60`). Profile support means `browser:<browser>:<profile>:chain:<hash>` —
a breaking re-key. If you are re-keying for A1 anyway, do both in one migration.

---

## 5) Combined view — a realistic first run

**Scenario: 30 days of browser (Chrome, the only browser currently discovered) + 1 year of WhatsApp.**

Inputs:
- Browser 30d = **667 chains** (CONFIRMED by chain simulation on the real Chrome DB).
- WhatsApp 1y ≈ 47,400 events across ~300 chats (ESTIMATE: V11's measured 7,278 events / 133
  chats / 56 days, scaled linearly).
- A bulk import lands in one or two polls, so WhatsApp backfill is ~1 bundle per stream, split
  only at `maxBundleEvents: 500` (`dispatch.ts:71`, read directly) → **~330 calls**.
  **WhatsApp is not the problem even at a year. Browser at 30 days costs twice as much as
  WhatsApp at 365.**

| configuration | browser calls | WA calls | total calls | $/call | **total** |
|---|---:|---:|---:|---:|---:|
| **today, as shipped** (orphan bug live, 6.47×) | 4,315 | 2,135 | 6,450 | $0.0286 | **$184** |
| + **A0** orphan cap only | 667 | 330 | 997 | $0.0286 | **$28.5** |
| + **A1** domain+day browser keys | ~240 | 330 | 570 | $0.0286 | **$16.3** |
| + **A3** WhatsApp tiered windows | ~240 | ~250 | 490 | $0.0286 | **$14.0** |
| + **B1** CLI flags fixed | ~240 | ~250 | 490 | $0.0058 | **$2.8** |
| + **B2** browser backfill → Digest | 30 | ~250 | 280 | ~$0.0058 | **$1.6** |

Arithmetic notes: browser 6.47× and $/call are CONFIRMED measurements; the WhatsApp 6.47×
multiplier is an ESTIMATE (the orphan scan is source-blind, so it applies equally); A1's ~240 is
an ESTIMATE (measured 643 domain+day streams over 80 days, scaled to 30 days); B1's $0.0058 is
computed as 1,940 input + 338 output at the confirmed prices.

**Two independent levers, and they multiply. A0+A1 is 11×. Adding B1 is 65×. The full stack is
~115×, and the first step is a slot check.**

Steady state, same data rate (43 visits/day):

| | browser calls/day | $/month |
|---|---:|---:|
| today's chain keys | ~30 | ~$26 |
| domain+day keys | ~8 | ~$7 |
| domain+day + B1 | ~8 | ~$1.4 |
| screen at today's `bundleId¦docKey` (8h/day) | ~340 | **~$220** |
| screen with A2 focus-session keys (ESTIMATE, ratio 2.08→4.2) | ~170 | ~$110 |
| screen with A2 + B1 | ~170 | ~$22 |

**Screen, not browser, is the bigger steady-state bill.** Browser was the visible disaster
because it arrived as a 90-day backfill in one hour. Screen arrives at $1.82/hour, forever,
and cannot be deferred by the existing brake.

---

## 6) Open questions only you can answer

1. **Is Cat-2 browsing worth any model call at all?** A Netflix `/watch` visit can be handled
   by a domain table and a digest row for $0. Everything downstream of this answer changes.
   (B2 is the largest single number in this document.)
2. **Subscription CLI or direct API?** Option 3 in §3 is the right transport on the merits and
   costs ~1,450 tokens instead of ~29,500. It needs an API key and moves billing off the
   subscription. Product call, not an engineering one.
3. **Is the spec's "streams never share a prompt" (§6.3.1) a hard rule or a default?** A1
   respects it. A4 does not. A4 is only worth the write-path surgery if the rule is negotiable.
4. **How stale may understanding be?** Every batching option trades freshness for cost.
   Which threads deserve 5-minute latency, and which are fine at a day?
5. **What happens to the 3,452 browser events already captured without consent?** Offer a
   one-time keep-or-delete card, or delete silently? (If delete: it must go through
   `hardDeleteEvents`, not `resetSourceData` — see §4.)
6. **Accept a one-time re-key of existing browser streams?** A1 and per-profile disconnect both
   need it. The corpus is small now and about to be re-consented anyway — this is the cheapest
   moment it will ever be.
7. **Should screen capture be on by default once Accessibility is granted?** At ~$220/month
   unmitigated, "permission granted = capture starts" is a costly default.
