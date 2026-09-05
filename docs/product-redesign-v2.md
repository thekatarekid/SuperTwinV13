# SuperTwin V13 — Product Redesign V2

Supersedes `docs/product-redesign-brainstorm.md` for everything below. That document's confirmed
numbers (cache economics, incident anatomy, URL classification, day-bundle sizing, stage-1/2/3
transport) are carried forward unchanged and not re-derived.

This is a brainstorm, not a plan. Written under five settled decisions:

1. Your own writing/drafts are in scope as a source.
2. Screenshot fallback = opt-in **local** OCR for AX-poor apps only. Vision models never by default.
3. History has **two tiers**: *processed* (a window you pick, default 30 days) and *accessible*
   (everything, indexed for search, never processed).
4. Target is **minutes-fresh**. Assist and understanding should be one lane.
5. **Nothing happens without consent.** No capture, no import, before you say yes.

All numbers CONFIRMED unless marked ESTIMATE. Sources: `~/SuperTwinV13/supertwinv13.db` (dbstat page
accounting, ledger), `~/SuperTwin/supertwin.db`, live browser history files, and code at cited
`file:line`. Read-only throughout.

---

## 1. The product in one page

```
┌─ CONSENT GATE ─ nothing below runs until you say yes, per source, with two windows ────────┐
│    [ INDEX ]      ← tier (b)   default: everything the source can give                     │
│    [ UNDERSTAND ] ← tier (a)   default: last 30 days   (can never exceed INDEX)            │
│  Enforced at the two single-writer funnels: db/eventlog.ts:229, db/ingest.ts:1396          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
                                        │
        ┌───────────────────────────────┴──────────────────────────────────┐
        │  ARCHIVE — narrow, append-only, ONE copy of the text.            │
        │  Everything you consented to index lands here, always.           │
        │  739 B/browser visit · 378 B/message · ~1.1 KB/screen capture     │
        │  + FTS5 over everything      (0.4–0.8 B per character)           │
        │  + int8 vectors over CHUNKS, not events   (782 B/vector)         │
        └────┬─────────────────────────────────────────┬───────────────────┘
             │ only ts >= understand_window            │ read-only, always, everything
             ▼                                         ▼
   ┌─────────────────────────────┐        ┌──────────────────────────────────┐
   │  ONE LANE  (understanding   │        │  GROUNDED BAR / GROUNDED CHAT    │
   │  + assist, one model call)  │        │  FTS recall (top 2,000, 3–13 ms) │
   │                             │        │  → cosine rerank on candidates   │
   │  LIVE: flush on 45 s idle,  │        │  → expand → cite by archive id   │
   │   or 120 s max, or express  │        │  never dispatches, never writes  │
   │   (INTENT_RE) → 0 s         │        └──────────────────────────────────┘
   │  BACKFILL: one call per     │
   │   calendar DAY, oldest→     │        Everything outside the understand
   │   newest, no clock, never   │        window is searchable but carries no
   │   nudges                    │        episode. The UI says so plainly.
   │                             │
   │  → nudge  p50 ≈ 64 s        │
   │    (express ≈ 19 s)         │
   │  → episode p50 ≈ 63 s       │
   │    (today: 166 s)           │
   └─────────────────────────────┘

TRANSPORT: stage 1+2 now — $0.0286 → $0.0057/call, no behavior change. Stage 3 after one eval.
RAILS: slot cap · in-flight dedupe · per-call --max-budget-usd · daily circuit breaker ·
       single-instance lock · per-item salvage · a new pool lane so nudges never queue behind
       backfill · pool.noteFailure finally wired.
```

**The thesis in three sentences.** Keeping history is nearly free; understanding it is what costs
money — measured, in your own database, at **739 B versus 18,100 B per event**, a 24× gap. So we
stop making one decision and start making two: index everything you own, understand the window you
choose. And because a nudge and a world-model update are the same act of comprehension, they become
one model call, which is cheaper, fresher, and the only shape that can produce the sentence you
asked for ("he is booking a villa and the advance is due at 5 pm") — because that sentence needs the
episode, the open task, and the clock, and **no pass in the product today holds all three**.

---

## 2. Two-tier history — the storage answer

### 2.1 The measured unit costs

Method: `dbstat` page accounting on the live 85 MB DB (3,543 events), plus per-source measurement in
scratch DBs loaded with **real rows** — 3,452 browser visits, 7,278 real WhatsApp messages, screen
rows carrying real 5,284-char prose.

| Structure | measured | per event |
|---|---|---|
| `bridges` + 3 indexes (82,976 rows) | **32.2 MB** | 9,088 B |
| understanding output (episodes, spaces, unsorted, entities, decisions, bridges) | 40.75 MB | **11,502 B** |
| pipeline telemetry (traces, runs, latency, work_queue) | 20.53 MB | **5,796 B** |
| `events` + 17 indexes | 9.01 MB | 2,543 B |
| `event_embeddings` (384d fp32) | 7.31 MB | 2,054 B |
| `events_fts` | 0.43 MB | 128 B |

`bridges` is the single largest object in the database and it is **pure tier-(a) derived data**. At
9.1 KB/event it costs more than the events themselves. It must not follow events into tier (b).

Same real rows, current schema vs a purpose-built narrow archive table:

| Source | current `events` | narrow archive | saving |
|---|---|---|---|
| `browser.visit` | 2,644 B | **739 B** | 3.6× |
| `wa.message` | 1,662 B | **378 B** | 4.4× |
| `screen.snapshot` (5,284 ch) | 10,526 B | **5,903 B** zlib | 1.8× |

Two measured causes: **the text is stored twice** (2,297 of 3,443 browser events have their `text`
verbatim inside `payload_json` as well — 66.7%), and **`events` is 62 columns wide**, so a 44-char
WhatsApp message pays ~350 B of NULL-column header before any content.

### 2.2 The table you asked for

Narrow archive, zlib text, FTS on everything, int8 768-dim windowed embeddings.

| Source | 1 year | 5 years | Everything available |
|---|---|---|---|
| Browser (live rate ~200 visits/day) | 0.10 GB | 0.52 GB¹ | **0.02 GB**² |
| WhatsApp (~250 msg/day) | 0.03 GB | 0.17 GB | **0.27 GB** (8 y ≈ 730 K msgs) |
| Writing / drafts (~340 docs) | 0.01 GB | 0.05 GB | 0.01 GB |
| Screen — **anchor + diff** | **0.79 GB** | 3.93 GB | n/a (no past) |
| Screen — full text per capture | 2.71 GB | 13.54 GB | n/a |
| **Total (anchor+diff screen)** | **0.93 GB** | **4.67 GB** | — |

¹ 5 years of browsing **does not exist on this Mac** and cannot be read locally. Every Chromium
browser expires visits at ~90 days — confirmed three separate times (Chrome 89 days, Comet 88,
Aside 91). A 5-year browser tier is a *Google Takeout import feature*, not a local-read feature.

² Verified today by read-only copy: **Chrome 3,138 + Brave 4,993 = 8,131 visits** in the browsers you
actually use; **+ Comet 5,855 + Aside 3,114 dormant on disk = 17,100**; up to ~45 K if every browser
ever installed counts. All three figures round to "a rounding error."

**Heavy-user headline** — 5 y browsing (via Takeout) + 8 y WhatsApp + 1 y screen, all indexed:

| Screen policy | Total |
|---|---|
| full text every capture, zlib | 3.49 GB |
| **anchor + diff (recommended)** | **1.57 GB** |

**Is "index everything" affordable? Yes, and it isn't close.** 1.57 GB is 0.3% of a 512 GB SSD.
Run rate is **0.92 GB per year of life**, so 150 GB of free space buys ~160 years. For scale: the
pipeline's own trace log for the incident day alone was **207 MB** — 27× a whole day of tier (b).

### 2.3 The embedding decision: chunk, don't filter

The question was "embed every event, or only events over N characters." **Neither.**

A length filter throws away the short messages that carry the most identity ("yes, book it", a phone
number, an address) — and 63.7% of your real messages are 1–39 characters. But FTS already finds
those by exact term, so they lose nothing by not having their own vector. The right move is to
change the **unit**:

| Source | unit | result |
|---|---|---|
| chat | rolling ~2,000-char window over consecutive messages | 1 vector per ~45 messages — 730 K msgs → 16,170 vectors → **0.012 GB** |
| screen | ~2,000-char chunks of the reconstructed document | ~2.6 vectors/capture, recomputed only on re-anchor |
| browser | one vector per visit (title + stripped URL), deduped by `content_hash` | 394 hidden duplicates already found |

Windowing is strictly better than either alternative — the short message gets a vector *with its
context* — and costs 45× less disk than one-per-event.

Quantization, measured per stored vector (768-dim, rowid-keyed table): fp32 3,280 B · fp16 1,640 B ·
**int8 782 B** at 16 KB pages. The live DB's 4 KB pages + TEXT primary key cost 34% overhead; 16 KB
pages and a rowid key recover almost all of it. **Embeddings add ~1 GB to a decade of a life.** They
are not the swing factor for disk.

**They are the swing factor for query time, and that wall is close.** `worker/src/retrieval/
semantic.ts:309` loads *every* vector into a process cache and `:251` does a linear cosine scan.
Benchmarked in node on this Mac:

| vectors | scan/query | resident (fp32) |
|---|---|---|
| 100,000 | 192 ms | 0.29 GB |
| 500,000 | 1,294 ms | 1.43 GB |
| 1,000,000 | 2,073 ms | 2.86 GB |

It breaks around **200–300 K vectors — roughly one year of screen capture.** Fix is a shape change,
not a library: **FTS5 recall (top ~2,000 by bm25, 3–13 ms at 221 K documents, index-lookup bound so
it does not degrade with corpus size) → cosine rerank on only those candidates (2,000 × 768 = 3.8 ms,
measured) → neighbourhood expansion → cite.** The existing `rank()` is kept verbatim; it just
receives a bounded candidate set. No ANN dependency, no index build step.

### 2.4 Retention — screen is the only source that needs a policy, and not for disk

Screen is 78% of the bill. Anchor+diff (store the first capture of a `doc_key` session in full, then
only `new_chars`, re-anchoring every ~20 captures) cuts the heavy-user total from 3.49 GB to 1.57 GB
in one decision. Beyond that:

| Policy | GB per year of capture |
|---|---|
| digest-only from day 0 | 0.45 |
| full text 7 days, digest after | 0.49 |
| full text 30 days, digest after | 0.64 |
| full text 90 days, digest after | 1.01 |
| full text forever (zlib) | 2.71 |

**Compaction saves ~2 GB per year. Nobody buys a policy for 2 GB.** So do not sell it as a capacity
control. Offer it as a *privacy* control — "stop keeping the words that were on my screen after 30
days" — with the disk figure shown small and honest underneath.

### 2.5 What the Library shows

Today `worker/src/server/library-routes.ts:64` reports event counts and nothing about bytes. Two
bars on one track, per source:

```
WhatsApp                                    ● indexed to 2018-03
──────────────────────────────────────────────────────────────
Searchable    730,412 messages · 8 years            274 MB
Understood     42,150 messages · last 30 days   [ change ]
▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  searchable
▓▓▓▓                                                understood

Keeping more history costs disk. Understanding more history costs money.
```

Three rules for that panel. **The two handles never share a control** — 739 B versus 18,100 B per
event, $0 versus real money. **Lead with free space**: "1.6 GB · 487 GB free" ends the conversation.
**Deletion stays symmetric**: a source delete purges archive + FTS + vectors **and** the tier-(a)
rows that reference them, via the existing `hardDeleteEvents` cascade
(`worker/src/library/delete-cascade.ts`). Storing more is only acceptable if removing it is one
button and complete.

---

## 3. One lane

### 3.1 The honest state today

Both passes already run on the same model, the same transport, and — this is the finding — **the same
concurrency lane**: `assist/evaluator.ts:175` and `brain/orient.ts:224` both pass
`lane: "understanding"`. They are already joined in the one place where sharing costs latency (the
semaphore, uncapped waiter queue at `providers/pool.ts:110`) and separate in the one place where
sharing would create value (the context).

| Block | Orient sees | Assist sees |
|---|---|---|
| episodes, spaces, thread history, roster, cross-source | ✅ | ❌ |
| **current wall-clock time** | ❌ (`pack.ts` has no `[NOW]`) | ✅ |
| **open tasks** | ❌ | ✅ |
| suppression / cooldown / quiet hours | ❌ | ✅ |

Your villa example needs the episode (Orient only), the open task (assist only) and the clock (assist
only, and Orient has none at all). **Neither pass can produce that sentence today, at any price.**

Measured cost and latency (CONFIRMED, ledger):

| Pass | calls | avg cost | avg prompt | avg output |
|---|---|---|---|---|
| `orient.v6` | 16,654 | **$0.02861** | 5,687 ch | 338 tok |
| `assist.v1` | 30 | **$0.02747** | 3,213 ch | 343 tok |
| `critic.v4` | 965 | $0.02510 | 2,693 ch | 261 tok |

**A nudge evaluation costs 96% of an Orient call.** The transport is the price, not the payload:
output is ~1.5% of the bill, so a second payload in one response costs ~1.5% and a second call costs
~100%. Today: nudge p50 ≈ 28 s, committed episode p50 ≈ 166 s.

Correction to the earlier estimate: simulating the real gate (`assist/gate.ts:305-330`) against your
real corpora gives **9.7 assist firings/day**, not "a few" — ~$8/mo of evaluator calls, most
producing nothing because the 0.7/0.6 thresholds are applied *after* the call. Unification deletes
that line entirely.

### 3.2 The flush policy — idle-gap beats every fixed window

Median inter-event gap in your real union corpus is 15 s; p75 is 110 s. Life is bursty, so a wall
clock is the wrong trigger.

| Policy | Calls/day | Freshness p50 | Events/call |
|---|---|---|---|
| fixed 5-min window (today) | 47.7 | ~150 s | 3.57 |
| fixed 2-min window | 61.8 | ~60 s | 2.76 |
| **idle 45 s / max 120 s** | **40.8** | **45 s** | 2.96 |
| **+ express (INTENT_RE)** | **41.9** | **45 s / express 0 s** | 2.88 |

Idle-flush is **strictly better than the 5-minute window already agreed** — 12% fewer calls at 3.3×
the freshness — because it never fires mid-burst and never waits out a clock after a burst ends.

**Do not go to a 1-minute window.** Cross-source co-occurrence — the villa-chat-plus-villa-tabs
inference this product exists for — collapses from 4.1% of windows at 5 min to **0.8% at 1 min**.
Shrinking the window trades away exactly the joining you are batching for.

| Parameter | Value |
|---|---|
| `idleMs` | 45 s |
| `maxAgeMs` | 120 s, backing off ×2 to a cap under sustained activity, reset on first idle flush |
| `maxChars` | 20,000 (one screen capture can be 22 K; keeps the pack under the 28 K cap) |
| express | `INTENT_RE` + ≥2 events in batch + 120 s debounce — measured **+5.8 flushes/day** |
| novelty | an event whose `content_hash` is already in the batch neither resets the idle timer nor counts (hoisted from `gate.ts:265`) |
| floor | ≤1 non-express flush per 30 s |

### 3.3 One call, two payloads

System block is static (both cores + the combined schema), so `llm.ts:81` stays satisfied; everything
variable — mode, clock, thresholds, quiet-hours state — goes in the user block, as `orient.v6`
already does.

```json
{ "understanding": { "episodes": […], "proposals": […], "unsorted": […], "questions": […] },
  "assist":        { "intent": …, "intent_confidence_0_1": …, "helpfulness_0_1": …,
                     "urgency": "now|today|none", "deadline_at": …, "action": …,
                     "artifact_type": …, "grounded_in": ["e3","e7"], "space_hint": …, "reasoning": … } }
```

The understanding half is **byte-compatible with `orient.v6`**, so `parseOrientOutput`,
`resolveEventAliases`, `buildCriticInput` and `commitTick` are reused unchanged under a
`.understanding` accessor. Combined output is 681 tokens — noise. Combined prompt ≈ 6,300 chars =
**22% of the 28,000-char cap**.

Two new assist fields earn their place. **`grounded_in`** — code checks every alias resolves to an
event *in this flush*, which kills a real defect: the accumulator at `gate.ts:305-330` checks
suppression, cooldown, quiet hours, count and new-content, and **never a timestamp**, so five events
spread over three weeks can fire a nudge today. **`urgency` + `deadline_at`** — only possible because
the pass finally sees `[NOW]`, and it lets quiet hours have an honest override class.

### 3.4 What breaks, and the answer

| Risk | Answer |
|---|---|
| **Failure coupling — one bad JSON kills two things** | **Section-independent parsing.** `.understanding` and `.assist` are try/caught separately. Same per-item-salvage principle already agreed, one level up. |
| `.understanding` invalid | invalid items quarantined per item; valid items commit; assist still fires |
| `.assist` invalid | understanding commits normally; assist dropped and logged; accumulator kept |
| Critic quarantines | commits as-is (existing behaviour); nudge already fired, unaffected |
| crash after call, before commit | events re-flush; re-nudge blocked by the existing `contentKey` dedupe (`artifacts.ts:82`) |
| Critic latency on the nudge | Critic grades the **understanding half only**, in parallel with executor-lite. The nudge never waits behind a 7.1 s call. |
| Backfill must never nudge | enforced twice: the backfill user block omits the assist instruction, and code discards any assist section when `lane !== "live"` |
| Safety / risk classes | **unchanged and structural** — `executor-lite.ts:89-93` frozen 3-tool table, asserted against `RISKY_TOOL_NAME_PATTERNS`. Unification adds no capability. |

The trigger gate does not disappear; it **moves from the input side to the output side**. Today it
decides "may we spend a call." Under unification the call happens anyway, so it decides "may we
interrupt" — same numbers from `settings.ts:27-38`, evaluated in code on the flush.

**One pool change is not optional.** `providers/pool.ts:69` has only two lanes. Add a third,
`"live"`, with ≥1 reserved slot; route the unified live pass to it and backfill + Critic + Decide to
`understanding`. Otherwise a backfill wave queues nudges behind it — the same structural coupling
that let 13,152 Orient calls wait over an hour during the incident. ~20 LOC, and it is what makes
"minutes-fresh" a property rather than a hope.

### 3.5 Verdict

**Recommendation: full unification of the live lane**, with three carve-outs — backfill day-bundles
stay understanding-only, express is a nudge-only fast path, and the Critic stays on the understanding
half.

Justified from quality, not tidiness:

- It is **the only configuration that can produce the villa/5-pm sentence.** Not an optimisation — a
  capability that does not exist today.
- It fixes measured defects for free: the accumulator with no recency bound; the assist cursor that
  advances *before* work (`watcher.ts:108`) and so loses events on crash while understanding does
  not; artifacts that carry no event-level evidence when every other write in the product is
  grounded.
- It is **cheaper and fresher than the design already agreed**: 77.3 → 41.9 calls/day (−46%),
  episode p50 166 s → 63 s, nudges express-immediate at 19 s.

| Design | Calls/day |
|---|---|
| today (per-stream @5 min + separate assist) | 77.3 |
| agreed redesign (window-bundles @5 min + separate assist) | 57.4 |
| **unified, idle 45 s / max 120 s + express** | **41.9** |

**Honesty item:** the assist lane has never produced a nudge from real user data. All 43 `artifacts`
rows have `run_id IS NULL`; all 30 `assist.v1` ledger rows came from eval executors. We would be
folding an unproven lane into a proven one — which is an argument for the gate below, not against
the design.

**The gate.** The one thing that cannot be settled by argument is whether two payloads fight for the
model's attention. Ship in this order, each step independently valuable and revertible:

1. `lane: "live"` in the pool + wire `pool.noteFailure` (unwired for every V13 pass today). Fixes
   nudge starvation before any prompt change.
2. `[NOW]` and `[OPEN TASKS]` into the Orient pack. Two blocks, no schema change, no new call. This
   alone may deliver most of the villa capability.
3. Flush trigger replaces the 5-min window for live. Still two calls. p50 166 s → 63 s.
4. `live.v1` — unified prompt, section-independent parser, code-side `nudgeVerdict`. Retire
   `assist.v1`.

Step 4 ships only if: ORIENT golden set **matches or beats** `orient.v6` (a regression is
disqualifying), AST set matches or beats `assist.v1`, the CROSS-N50 fixture produces one space + two
episodes + **exactly one nudge citing both sources**, and a backfill bundle containing a three-month-
old "pay by 5 pm" emits **zero** assist output.

**Fallback if the eval regresses: shared context, separate calls.** Keep steps 1–3 and the merged
pack, make two calls off it. Still delivers the clock, the tasks, the episodes and the freshness;
only forgoes the ~15 calls/day that folding the second call saves. Steps 1–3 are worth shipping
regardless. **"Stay separate" is not defensible** — it preserves a context split with no benefit, an
accumulator with no recency bound, and a nudge lane that costs 96% of an Orient call to produce
nothing 8 times a day.

---

## 4. Consent model

### 4.1 What auto-starts today with zero consent — CONFIRMED

`main()` in `worker/src/index.ts` starts every capture path unconditionally. There is no consent
check anywhere on the boot path.

- Browser watcher (`index.ts:97` → `watcher.ts:132`): `const floor = opts.sinceMs ?? this.now() -
  90 * DAY_MS`, and `start()` fires `queueMicrotask(() => this.pollSafe())`. **The first 90-day
  import runs within a microtask of boot.**
- Screen sidecar (`Live.swift:55`) polls `AXIsProcessTrusted()` every second and **begins capturing
  the instant permission flips true** — no in-app "start recording" step.
- WhatsApp adapter reconnects silently if a session exists on disk.

Proof it already happened here: `sources` has 5 rows, all `enabled=1`, and **`connected_at` NULL on
every one** — 3,452 browser events exist behind a table that records no connection ever happening.

Worse, the privacy controls mostly do not work:

| Control the user sees | Actually stops capture? |
|---|---|
| Settings → Capture whatsapp | **Yes** |
| Settings → Capture browser | No — display only |
| Settings → Capture screen | No — display only |
| App blocklist / Domain blocklist / Page-text rules | No — **read by nobody** (grep: zero hits outside `settings-routes.ts`) |
| **Menu-bar ⏸ "capture paused"** | **No — it pauses nudges** (`assist/watcher.ts:97` is its only consumer) |

Six of seven are inert, including the most visible one. And there is no source delete: the path a
user reaches (`resetSourceData`) runs raw DELETEs and **never calls `hardDeleteEvents`**, so a
WhatsApp reset today would strand **4,409 episodes, 65 spaces, 4,314 unsorted rows** citing event ids
that no longer exist.

### 4.2 The record and the gate

```sql
CREATE TABLE consents (
  source_id        TEXT PRIMARY KEY,
  state            TEXT NOT NULL,      -- connected | paused | disconnected
  granted_at       TEXT NOT NULL,
  granted_build    TEXT NOT NULL,      -- a build that WIDENS scope must re-ask
  scope_json       TEXT NOT NULL,      -- {profiles, folders, apps}
  processed_from   TEXT,               -- tier (a) floor. NULL = live-only (screen)
  processed_window TEXT NOT NULL,      -- the label the user actually picked
  accessible_all   INTEGER NOT NULL DEFAULT 0,   -- tier (b)
  revoked_at       TEXT,
  decision_id      TEXT NOT NULL       -- the decisions row holding the exact card text shown
);
```

**One gate, three sources.** `captureAllowed(source)` is checked at the two single-writer funnels
that every adapter already passes through — `db/eventlog.ts:229` and `db/ingest.ts:1396`, right
beside the per-stream pause that already works. **A new adapter inherits the gate for free.** That
one function also retires all six dead controls.

**The tier mechanism is one predicate, not a filter someone can forget.** Tier-(b) rows are inserted
with `origin='archive'` and `dispatched_at = capture_ts`, so they are invisible to the dispatcher and
to the orphan scan by construction. Widening the window later is
`UPDATE events SET dispatched_at=NULL, origin='backfill' WHERE ts >= ?` — a pure replay, no
re-ingest, no re-capture, no consent re-ask. Bridges and embeddings do **not** run on tier (b) at
ingest.

### 4.3 The connect flows

Every flow is: **enumerate → show real numbers → pick processed window → pick index tier → confirm.**
Nothing before the confirm writes an event.

**Browser.** Enumerate every installed browser and **every profile** — today `discoverProfiles()`
hardcodes three paths (Chrome `Default`, Arc, Safari), which is why Brave's 4,993 visits are
invisible. Copy-then-read costs **40 ms per profile** and imports nothing. Then show real counts, and
state the plateau honestly:

`1d 306 · 3d 578 · 7d 1,597 · 30d 6,091 ✓ · 90d 8,131 · 180d–5y 8,131 · Everything 8,131`

> *Chrome keeps 90 days and Brave 29 — that's all your browsers still hold, so anything past 90 days
> imports the same 8,131.*

Safari gets a real blocker, not a silent zero: `cp ~/Library/Safari/History.db` returns
*Operation not permitted*, so the card must say "macOS blocks Safari history until you give SuperTwin
Full Disk Access" rather than failing silently at `watcher.ts:181`. And one disclosure the current
card omits: **page URLs already carry the absolute file paths of local documents** — 307 of them from
Roughdraft, e.g. `?path=%2FUsers%2F…%2FSuperTwinV11_Product….md`.

(The current "Connect your browsing" card is also unreachable — it renders only when
`event_count === 0`, and the watcher imports 90 days at boot, so it is gone before you ever open
Library. Its copy says *"SuperTwin never reads Chrome's encrypted stores itself"*; the watcher reads
Chrome's History SQLite directly.)

**WhatsApp.** Already closest to right, because QR pairing is real consent. Finish it: pair, let the
history sync land **in the daemon buffer** (the adapter already supports pairing with no range), then
show *measured* counts per window from `messagesInRange` instead of guesses. The honest caveat, which
the `HistoryDepth` machinery already computes: *"WhatsApp decides how much it sends. We'll tell you
what actually arrived."*

**Screen.** No history, so no window to pick — but the loudest consent, because it is the only source
that captures *other people's* words. Invert the boot order: the sidecar spawns only after a consent
row exists. Then Accessibility permission, then an explicit second **"Record from now on"** listing
what is captured (frontmost window text, app, title, doc/URL) and what never is (password managers,
private windows — already enforced twice). And a **real recording indicator**: repoint the tray ⏸
from `assist.capture_paused_until` to actual capture state, add a distinct recording glyph, make one
click actually stop capture. Screen shows a **rate** (~0.8–2.7 GB/year), never a total.

**Writing / drafts** — see §5.1.

### 4.4 The confirm card

Four lines, each carrying its own accuracy:

| Number | Where it comes from | Accuracy |
|---|---|---|
| **Events to process** | browser: `COUNT(*)` on the read-only copy · WhatsApp: `messagesInRange` from the buffer · writing: file scan · **screen: none, no past** | exact where it says exact; the WhatsApp caveat is printed, not hidden |
| **Cost** | `days × $0.0104` (from the agreed day-bundle figure, Critic included). 30 d ⇒ **~$0.31**, 90 d ⇒ **~$0.94** | ESTIMATE ±40%. *"about 30¢ — we'll stop and ask if it passes $2"*, wired to `--max-budget-usd` and the daily breaker so the promise is enforced |
| **Time** | `days × 8.2 s`, **serial** (day-bundles run oldest→newest so each day sees prior days). 30 d ⇒ **~5 min**, 90 d ⇒ **~15 min** | ESTIMATE ±30%. Do not quote a concurrency-8 number — it would be an 8× lie |
| **Disk** | narrow-archive model, fitted to two real corpora within 3% and 14%. Browser 8,131 ⇒ **21 MB**. WhatsApp 8 y ⇒ **274 MB** | CONFIRMED coefficients, ESTIMATE volumes; a live counter after connect makes it checkable |

Rules: **no number the code cannot compute at that moment.** If it is an estimate, the word "about"
appears. The card text is stored verbatim in the `decisions` row referenced by
`consents.decision_id`, so "what exactly did I agree to" is answerable a year later.

### 4.5 Disconnect · pause · delete

| Verb | Capture | Events | Understanding | Reversible |
|---|---|---|---|---|
| **Pause** | stops now | kept | kept | yes — gap visible in the timeline |
| **Disconnect** | stops, adapter torn down, session dropped | kept, searchable | kept | yes — reconnect re-asks |
| **Delete history** | unchanged | **hard-deleted via `hardDeleteEvents`** | cascaded away | **no** |
| **Disconnect + delete** | both | both | both | no |

Order matters: **consent flips before the adapter stops.** If teardown throws, capture is already
blocked at the funnel. Deletes are a **preview, not a surprise** — `hardDeleteEvents` already returns
a full `CascadeReport`; run it in a transaction, show "1,204 events, 38 episodes, 2 spaces, 1 task",
commit on confirm.

**Shortening the processed window is not a delete.** Events aged out fall from tier (a) to tier (b) —
still searchable. Understanding already derived from them **stays**, because it is a true record of
what happened and silently deleting it would rewrite your history. The UI says it plainly:
*"Days 31–90 stop feeding new understanding. What SuperTwin already learned from them stays —
[review it] · [delete it]."* Disconnect without delete labels the source honestly:
*"WhatsApp — disconnected 12 Mar. 4,102 messages still searchable, 38 spaces still built on them."*

**Sequencing answer.** On the open question of whether assist may act on screen events before consent
ships: **hold.** With the menubar pause not pausing capture and three blocklists read by nobody, a
nudge quoting your own screen back at you is the moment trust breaks. The consent work is ~300 LOC
and one migration, and everything else waits on it anyway.

---

## 5. Sources

### 5.1 Writing / drafts — a lens, not a new adapter

**The headline: Roughdraft is a local web app, and it is already the biggest thing in your corpus.**
URL shape `http://rdN.localhost:7373/?path=<urlencoded absolute path>`. So the browser watcher and
the AX screen walk **already capture it**. What is missing is a recognizer.

| Fact | Value |
|---|---|
| Roughdraft events in the DB | **836** = **24.2% of the entire browser corpus** |
| Distinct `rdN.localhost` hosts | 92 |
| Distinct `.md` documents | 339 |
| Active days (of 80) | 57 |

For scale, the largest single hosts are `netflix.com` 716 and `hotstar.com` 695. Your own writing
beats both — it only looked small because it is shattered across 92 hostnames.

**What the system did with it:** 603 episodes whose summary contains `.md`; **594 of them (98.5%)
filed as unsorted**; 4 attached to a space; mean confidence 0.36. Real model output from the trace:
*"File access without stated goal, commitment, or repetition context."* The model is not wrong. It
was handed a URL. Hours of your own thinking became "opened a file."

Three separable defects: the document identity sits in the URL and is never decoded; a `domain+day`
stream key fragments one app 92 ways (the model's own reason says it — *"prior opens exist but in
separate streams"*); and `watcher.ts:59` sets `text = title + url`, so there is zero content.

**Design: `write.session` is a derived kind produced by a recognizer on top of the browser and screen
lanes.** Zero new daemons, zero new permissions. It fires when either:

- **(i)** the tab URL matches a registered local-editor pattern (Roughdraft's, declared once at
  connect: `doc_path = decodeURIComponent(params.path)`), **or**
- **(ii)** the focused AX element is a text area/field/contenteditable, the trigger is
  `typing_pause`, and `new_chars` is a genuine insertion of ≥40 chars — which makes VS Code, Notes,
  Obsidian, Bear, Word, Pages and Mail-compose work with no per-app integration.

Stream key becomes `write:<doc_path>`, not `domain+day` — the **document** is the identity, the day
is the batching unit. One 57-day arc instead of 92 shards. The event carries `ts`/`ts_end`,
`added_chars`/`removed_chars`, the **added text in order** (not the whole document re-sent), a
content-addressed `doc_snapshot_ref`, and `is_own_writing: true`.

**Settling the two lanes' disagreement:** one lane proposed a drafts-folder watcher, the other
rejected it. The lens wins for **capture** — a folder watcher is a third mechanism duplicating two
working ones, fires on every autosave, and would ingest documents you never opened. But the folder
picker wins as the **consent unit**, which is what it was really good at. So: capture through the
lens, scope through a **folder + app allowlist, empty by default, never a denylist**. Roughdraft's
own local API (`127.0.0.1:7373` SSE) stays an optional enrichment, not a foundation — it is
version-coupled to a third-party `0.1.x` package.

**Two privacy rules unique to writing.** **R1 — ephemeral until settled**: a writing event does not
reach the understanding lane until its session has been idle ≥10 min and the document still exists. A
sentence typed and deleted 30 seconds later must never become a claim about you. **R2 — never quote
drafts back proactively**: assist may say "you've been on the paperclip roadmap three days running"
(title + metrics) and never quote content. Grounded chat may quote it when *you* ask. A nudge reading
a half-written paragraph back at you is where trust ends.

Two rails: never watch a folder containing `.env`, `.ssh`, key material or `.git` internals; and
**whitelist `path` on `*.localhost:7373`** in the Layer-2 tracking-param stripper, or connecting
writing silently destroys the identity it depends on.

### 5.2 Screen worker fixes, ordered by value per LOC

| # | Fix | Where | LOC |
|---|---|---|---|
| **1** | **Identity + kind in every event head.** `pack.ts:258` renders `e7 08-18 10:27 self: <text>` — no app, no title, no doc_key, and `[kind]` renders only in the digest branch, which never runs. **Every event in every bundle ever sent looked identical across sources.** Cost ~100 chars against a 28,000 cap. | `pack.ts:258,261` | ~30 |
| **2** | **Persist full text.** `envelope.ts:95` stores only `frame.new_chars`; the sidecar sends both. Measured: 132,091 chars captured → 37,352 stored, **71.7% deleted**; a heartbeat stores 332 of 21,999. One line, and it fixes FTS in the same stroke (`eventlog.ts:242` projects `payload.text`). Add a content-addressed blob table so near-duplicate heartbeats don't re-store 22 KB. | `envelope.ts:95` | ~5 (+60) |
| **3** | **Revive the digest layer — code-only for screen.** `CONTENT_KINDS` lists three kinds **nothing emits**; `content_digests` = 0 rows, `run_context_stats` sums L0/L1/L2 = 0/0/0 across 16,654 calls. **Cost warning:** `ensureDigests` makes one Haiku call per unique `content_hash` — at ~1,000 captures/day with ~96% unique that is **~970 calls/day ≈ $165/mo**, an order of magnitude above the whole live budget. Use the existing free deterministic `distillContent()`; gate model digests to `length > 8,000` **and** one per (stream, 10-min window). | `digest.ts:50-54` | ~3 + gate |
| **4** | **Budgeted truncation.** `.slice(0, 1200)` is fixed regardless of bundle size — a 1-event day and a 150-event day get the same allowance. Derive from remaining budget (floor 400, ceiling 4,000). | `pack.ts:263` | ~20 |
| **5** | **Session arcs (`ts_end`).** Fold same-stream runs into one arc bounded by a 30-min idle gap. ~1,000 daily point-events become ~40 daily arcs. Prerequisite for `write.session`. | new | ~80 |
| **6** | **Revive the AX role walk.** `Live.swift:216,224` collects element roles and `RawCapture` never carries them; `main.swift:62` uses the default hasher, which is text-shaped — so the "structure vs content" dedup distinction does not actually exist. Restoring it delivers the *"the user is typing here"* signal that §5.1 rule (ii) depends on. | `Live.swift`, `main.swift:62` | ~35 |
| **7** | **Enrich the FTS projection** with app · window_title · doc_key. Directly serves tier (b) — "the tab about villas" is unfindable today. | `eventlog.ts:242` | ~5 |
| **8** | **Retire or wire `content_pending`.** Writers exist, **zero readers**; costs 556 B/event. Decide, don't leave it. | | 10 / 150 |
| **9** | **Node-side line diff for writing.** `Dedup.swift:47-55` is a prefix/suffix trim, so a one-word edit in paragraph 3 returns the whole middle span as "new" — fine for chat, wrong for a writing source. | new | ~80 |

Also worth rendering and currently thrown away: WhatsApp reply/thread structure (`reply_to`,
`reaction_to`, `forwarded`, `mentions`, real audience are all captured and none reach the model), and
browser transition type (`typed` 276 · `form_submit` 41 · `bookmark` 30 — "typed goibibo" ≠
"redirected to goibibo"). Do **not** render `dwell_ms`: 261 events are 0 and the non-zero values are
1–10. Render `visit_count` instead.

### 5.3 Local OCR fallback

Opt-in, local only, default **off**, vision models never.

**Confirmed available and benchmarked on this Mac, offline.** `VNRecognizeTextRequest` compiled and
run in the scratchpad: 30 languages, `conf 1.00` on screen-shaped text. **63 ms** for a 1512×982
window, **109 ms** for a 3024×1964 retina window at `.fast` — which recovered *identical* character
counts to `.accurate` on rendered UI text. At 2–3 allowlisted apps that is **~0.03% of one core**.

Build wrinkle, confirmed by experiment: Swift `import Vision` fails on this bare CommandLineTools
install (`redefinition of module 'SwiftBridging'`), the same failure class the repo already documents
for CryptoKit. Plain `clang -framework Vision` works first try — so Vision goes through a ~40 LOC
ObjC shim, following the existing CommonCrypto precedent.

**AX-poor detection is not a close call** — from your own capture data: Claude desktop **13 chars**,
UserNotificationCenter 160, System Settings 525–858, Finder 1,834, Brave **21,998**. Three orders of
magnitude. Threshold at ~200 chars.

OCR fires only when **all** hold: the app is on a per-app **allowlist that is empty by default**;
`ax_poor` is true over the last 5 captures; trigger ∈ {app_switch, window_switch, typing_pause} —
**never heartbeat**; and ≥20 s since the last OCR of this stream.

**The one rule that does all the work:**

> **OCR output enters the pipeline as `RawCapture.text`. Never as a separate frame type.**

Because `Snapshotter.process()` computes `privacy.dropReason(for: raw)` **before** anything is
hashed, diffed or emitted, OCR text automatically inherits — with zero new code — the password-manager
blocklist, private-window detection, global pause, per-app pause, and the Node-side re-check. Any
design that emits OCR as its own frame kind loses all of it.

**The honest risk.** Bundle-id filtering works because we know the app before taking the picture.
What genuinely breaks is **sub-window secrets** — a 1Password popover floating over an allowlisted
app, a Messages banner, a video-call window, someone else's thread inside a screen-share. Six
compensating checks:

| | Check |
|---|---|
| C1 | **Window-only capture, never display capture.** Removes banners, menu bar, every floating panel. Biggest mitigation; costs nothing. |
| C2 | **Occlusion abort** — scan `CGWindowListCopyWindowInfo` for higher-layer windows intersecting the target; if any is a password manager or NotificationCenter, skip the capture entirely |
| C3 | **Secure-field abort** — if the AX walk (which runs anyway) found any `AXSecureTextField`, skip OCR for that stream. A login screen is precisely AX-poor *and* secure-field-bearing. |
| C4 | **Post-OCR line redaction before hashing** — digit runs, OTP shapes near "code"/"OTP", `sk-`/`ghp_`/`AKIA` key shapes. **A backstop, not a guarantee**, and it must be described that way. |
| C5 | Allowlist + live menu-bar indicator (macOS lights its own; you deserve to know which feature lit it) |
| C6 | **Hard NEVER-OCR list checked before the allowlist** — every bundle already in the privacy list, plus Messages, Mail, WhatsApp, Signal, Keychain, Passwords |

Images are never written to disk, never a blob ref, never in a crash log; `CGImageRelease` before the
text is used, plus a test asserting no path can serialize a `CGImage`.

**The consent copy must say "this reads your screen,"** not "this fills a gap in accessibility text."
It costs a **Screen Recording** grant the product has never asked for — a scarier permission that
lights the system recording indicator and re-prompts periodically.

---

## 6. What we drop

Carried forward from the earlier brainstorm's drop list (all still dropped): one-stream-per-call
dispatch · scalar `bundle.streamId` · rowid-range episode membership · all-or-nothing
parse/repair/quarantine · engagement-tiered hot/warm/cold delays · uncapped orphan rescan · fresh
CLI session per call with 1h cache TTL · whole-URL drop lists · the 90-day floor as cost protection.

New in this design:

| Dropped | One-line reason |
|---|---|
| The separate assist lane (`assist.v1`, 20 s tick, its own cursor) | 96% of an Orient call to produce nothing 8× a day, on a context that can't see episodes |
| Fixed 5-minute dispatch windows | idle-gap flush is cheaper *and* 3.3× fresher on your real data |
| `events` (62 columns) as the storage table | text stored twice in 66.7% of rows; a narrow archive is 3.6–4.4× smaller |
| One embedding per event | a 44-char message is a terrible unit; windowed chunks are better retrieval at 45× less disk |
| Bridges and embeddings on tier (b) | 9.1 KB/event, and they exist only to serve the understanding lane's joins |
| Model-call digests for screen | ~970 calls/day ≈ $165/mo; the free deterministic distiller already exists |
| Both concurrency lanes sharing one semaphore | a backfill wave queues nudges behind it — the incident's coupling |
| `sources.connected_at` and `sources.enabled` | zero readers, zero writers; columns that look like consent and mean nothing are worse than none |
| Three blocklists + two capture toggles + the tray ⏸ | six of seven privacy controls are read by nobody; one `captureAllowed()` retires them all |
| `resetSourceData`'s raw DELETEs | would strand 4,409 episodes citing dead event ids; route through `hardDeleteEvents` |
| Boot-time auto-start of every adapter | the whole of decision 5 |
| The hardcoded 90-day browser floor | replaced by `consents.processed_from`; `sinceMs` becomes **required** so the default can't return by omission |
| `content_pending` | writers, no readers, 556 B/event |
| Assist artifacts without evidence | every other write in the product is grounded; `grounded_in` fixes it |
| 1-minute live windows as a freshness idea | kills cross-source co-occurrence 4.1% → 0.8% |
| Vision-model screenshots | settled: never by default |

---

## 7. Costs and volumes

Stage-2 transport ($0.0057/call). Critic at today's 21.7% attach rate rising toward 50% as bundles
get richer — budgeted at ×1.5 throughout.

### First run — the two tiers priced separately

| Choice | Days processed | Calls | Cost | Wall clock (serial) | Disk (indexed) |
|---|---|---|---|---|---|
| **30 d default**, all sources | 30 | ~45 | **~$0.26** | **~4 min** | 21 MB browser + 8 MB chat |
| 90 d | 90 | ~135 | ~$0.77 | ~12 min | same + |
| Browser everything (90 d floor) + WhatsApp 1 y | ~365 | ~550 | ~$3.10 | ~50 min | ~50 MB |
| WhatsApp everything (8 y ≈ 2,200 active days) | ~2,200 | ~3,300 | **~$18.80** | **~5 hours** | 274 MB |
| **Indexing all of the above** (tier b, no model ever runs) | — | **0** | **$0.00** | minutes | the §2.2 table |

This is the whole point of the two tiers in one table. Eight years of WhatsApp costs **$0 and 274 MB
to keep and search**, and **~$19 and five hours to understand**. Those are different decisions and
they now have different controls.

### Steady month, live

| Configuration | Calls/day (incl. Critic) | $/month | at stage 3 |
|---|---|---|---|
| Browser + WhatsApp + writing, no screen | 63 | **~$10.80** | ~$4.20 |
| **+ screen, 300 s backoff cap** ("Live") | 192 | **~$32.80** | ~$12.70 |
| + screen, 600 s backoff cap ("Balanced") | 115 | **~$19.70** | ~$7.60 |
| Assist evaluator | **0** — folded into the lane | **$0** | $0 |

ESTIMATE on the screen rows: derived from 2.11 captures/min measured over a real session, overlaid on
your real browser+WhatsApp corpus. Two fixes should pull these down and are not yet priced in —
hoisting the content-hash novelty filter into the flush trigger (so repeat heartbeats neither reset
the idle timer nor count), and session arcs (§5.2 fix 5). On the real no-screen corpus the backoff is
a **no-op** (41.2 → 40.9 calls/day); it only engages when activity is genuinely continuous.

This corrects the earlier "$15–20/mo with screen" figure upward for the Live setting: that estimate
predated the measured screen capture rate and the assist gate simulation.

### Disk, steady state

| | per year |
|---|---|
| Browser + WhatsApp + writing | 0.14 GB |
| Screen, anchor + diff | 0.79 GB |
| **Total run rate** | **0.93 GB/year** |
| Understanding output (tier a, 30-day window) | ~0.1 GB/year |

---

## 8. Open questions

Four, and only four. Everything else in this document is settled by measurement.

**Q1 — Screen freshness: "Live" or "Balanced"?**
The backoff cap under sustained activity is the last genuine quality-vs-cost knob. 300 s cap ≈
**$33/mo**, screen understanding ≤5 min behind you. 600 s cap ≈ **$20/mo**, screen understanding
lags ~10 min. **Nudges are unaffected either way** — express is not window-bound, so this only
changes how fast the world model catches up, never how fast you get told something. One setting, two
labels, honest copy.

**Q2 — Does deep history ever get *processed*, or is it search-only forever?**
Eight years of WhatsApp: **$0 to index, ~$19 and ~5 hours to understand.** The default 30-day window
is right for a first run. But is "understand my whole life" a thing you eventually want to buy once —
in which case the day-bundle replay needs a resumable, pausable, progress-visible background job —
or is deep history permanently a search surface, in which case tier (a) never needs to scale past a
few hundred days and the job stays simple?

**Q3 — Do we ask for Screen Recording at all?**
OCR is confirmed free, fast (109 ms), local, and multilingual. But it needs a permission the product
has never requested — one that lights macOS's own recording indicator and re-prompts periodically —
and the six compensating checks in §5.3 are mitigations, not guarantees, against secrets that appear
in pixels but never in the AX tree. The alternative is honest and cheap: **don't ask, and accept that
Figma canvases, video, games and Electron apps with poor AX are simply not understood.** Ship the
allowlist machinery either way; the question is whether the toggle exists in v1.

**Q4 — When you shorten the processed window, what happens to what was already understood?**
Proposed: it **stays**, labelled, with a one-click review-and-delete — because it is a true record of
what happened and silently erasing it rewrites your history. The other reading is equally coherent:
"stop processing days 31–90" *means* "forget what you learned from them," and anything else is the
product keeping something you asked it to stop keeping. This is a values call about what the window
means, not a technical one.
