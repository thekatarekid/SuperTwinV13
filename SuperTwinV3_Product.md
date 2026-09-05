# SuperTwin V3 — Product Spec

This document describes the product as it should be. It does not describe the current code.
It supersedes `SuperTwinV13_Product_V2.md` for design. Evidence and measurements live in
`docs/product-redesign-v2.md`, `docs/product-redesign-brainstorm.md`, `docs/bundle-design-brainstorm.md`,
`docs/stream-economics-options.md` and `docs/incident-runaway-spawn.md`; this document cites them, it does not repeat them.

Numbers are the measured ones from those documents unless marked ESTIMATE.

---

## 1. Principles

1. **Capture everything, with consent.** Nothing is captured, imported or read before the user says yes, per source.
2. **Two decisions, not one.** *Keeping* history is nearly free (≈0.7 KB/event). *Understanding* it costs money (≈18 KB/event, plus model calls). The user controls the two separately.
3. **Context over calls.** A model call that sees one event cannot understand an evening. Bundle by time, not by stream. Fewer, richer calls.
4. **One lane.** A nudge and a world-model update are the same act of comprehension. They happen in one call.
5. **Minutes-fresh.** Understanding lags life by seconds to a few minutes, never hours.
6. **Grounded.** Every episode, claim, task and nudge cites the events it came from.
7. **Nothing runs away.** Every model call passes a spend ceiling, a slot cap and a trace. A runaway is bounded by design, not by luck.

---

## 2. The product in one page

```
CONSENT GATE — per source, two windows: INDEX (everything) · UNDERSTAND (default 30 days)
        │
        ▼
ARCHIVE — one narrow, append-only copy of every event. FTS over all of it. Chunk embeddings.
        │                                            │
        │ only events inside UNDERSTAND window        │ everything, read-only
        ▼                                            ▼
ONE LANE                                     GROUNDED SEARCH / CHAT
  LIVE: flush on 45 s idle / 120 s max /      FTS recall → rerank → expand → cite
        express on intent                     Never dispatches. Never writes.
  BACKFILL: one call per calendar day,
        oldest → newest, never nudges
  → episodes, spaces, tasks, claims
  → nudge (only from the live lane)
```

---

## 3. Consent

### 3.1 The gate

1. One `consents` record per source: state (`connected | paused | disconnected`), granted time, granted build, scope, understand window, index-all flag, revoke time, and the id of the exact card text the user agreed to.
2. One function, `captureAllowed(source)`, is checked at the single write funnel every adapter uses. A new adapter inherits the gate for free.
3. No adapter starts, polls, pairs or reads history until its consent record exists. Boot order is: consent → permission → adapter.
4. A build that widens what a source captures must re-ask.

### 3.2 Two windows per source

| Window | Meaning | Default | Cost |
|---|---|---|---|
| **INDEX** | Stored in the archive, searchable, never sent to a model | everything the source can give | disk only |
| **UNDERSTAND** | Also sent to the understanding lane | last 30 days | model calls |

- UNDERSTAND can never exceed INDEX.
- Tier is a property of the row at write time (`origin='archive'`, already marked dispatched), so indexed-only rows are invisible to the understanding lane by construction.
- Widening UNDERSTAND later is a replay of archived rows, never a re-import.
- Screen has no past, so it has no windows: it is live-only.

### 3.3 The connect flow (every source)

1. Enumerate what exists (browsers × profiles, WhatsApp chats, apps).
2. Show **real counts** per window. If a source plateaus (Chromium keeps ~90 days), say so.
3. Pick UNDERSTAND window. Pick INDEX tier.
4. Show the confirm card. Nothing is written before confirm.

**Confirm card** — four numbers, each with its own accuracy label:

| Number | Source of truth | Label |
|---|---|---|
| Events to process | counted from the actual data | exact |
| Cost | `days × $0.0104` (ESTIMATE ±40%), enforced by a per-call and daily ceiling: *"about 30¢ — we'll stop and ask if it passes $2"* | about |
| Time | `days × 8.2 s`, serial | about |
| Disk | archive model, per source | about |

Rule: **no number the code cannot compute at that moment.** The card text is stored verbatim.

### 3.4 Pause · Disconnect · Delete

| Verb | Capture | Events | Understanding | Reversible |
|---|---|---|---|---|
| Pause | stops now | kept | kept | yes |
| Disconnect | stops, adapter torn down | kept, searchable | kept | yes (reconnect re-asks) |
| Delete history | unchanged | hard-deleted with full cascade | cascaded away | **no** |

- Consent flips **before** the adapter stops. A failing teardown still leaves capture blocked.
- Delete is a **preview, then confirm**: "1,204 events, 38 episodes, 2 spaces, 1 task."
- Shortening UNDERSTAND is not a delete. Understanding already derived **stays**, labelled, with one-click review-and-delete.

### 3.5 Indicator

The menu bar shows real capture state (recording / paused / off), per source. One click actually stops capture. It never shows nudge state as if it were capture state.

---

## 4. History and storage

### 4.1 Archive

1. One narrow table. One copy of the text, compressed. Payload kept raw.
2. FTS over everything, including app, window title and document key.
3. Embeddings over **chunks**, not events: chat = rolling ~2,000-char window over consecutive messages; screen = ~2,000-char chunks of the reconstructed document; browser = one per visit (title + stripped URL), deduped by content hash. int8.
4. Screen stores **anchor + diff**: the first capture of a document session in full, then only new characters, re-anchoring every ~20 captures.
5. Derived data (bridges, embeddings, episodes) is never built on indexed-only rows.

Budget: **~0.9 GB per year of life** with screen on; a heavy user with 5 y browsing, 8 y WhatsApp and 1 y screen fully indexed is ~1.6 GB.

### 4.2 Retention

Screen text retention is a **privacy** control, not a capacity control: "stop keeping the words that were on my screen after N days." Disk saving shown small and honest underneath.

### 4.3 The Library

Per source, two bars on one track — **searchable** and **understood** — with counts and bytes. Free disk shown first. The two windows never share a control. Copy: *"Keeping more history costs disk. Understanding more history costs money."* Events outside UNDERSTAND are labelled searchable-only.

---

## 5. Sources

### 5.1 WhatsApp
- QR pairing is the consent. History lands in a buffer; counts per window are measured from it, not guessed. Caveat printed: *"WhatsApp decides how much it sends. We'll tell you what actually arrived."*
- Reply, reaction, forward, mention and audience structure is captured **and rendered to the model**.
- Send requires an approval token. No token, no send path.

### 5.2 Browser
- Every installed browser, every profile, enumerated. Copy-then-read. Safari blocked by macOS is a real message, not a silent zero.
- **Keep 100% of visits.** No URL drop lists. Chrome's visits API records only top-level navigations; the "spam URL" category has zero members.
- **Strip tracking params at emit, in the text field only.** Denylist that fails open, with a small per-domain content allowlist checked first (`youtube/watch → v,t,list` · `google/search → q,udm,tbm` · `*.localhost:7373 → path` · …). Raw URL stays on the payload. Survivors sorted, fragment dropped unless route-shaped, 200-char cap.
- Render transition type (typed / form_submit / bookmark) and visit count. Never dwell.
- Render-time collapse of ≤30 s duplicate visits into one line with ×N.
- Stream identity: **domain + day**, keyed by browser and profile.
- Disclose that page URLs may carry absolute local file paths.

### 5.3 Screen
- Captures the frontmost window's full accessibility text (visible and scrolled-out), app, window title, document key, links and file paths. Triggers: app/tab/window switch, typing pause, scroll stop, 60 s heartbeat.
- Password managers and private windows are dropped **before** anything is hashed, diffed or emitted.
- Every event the model sees carries **app · title · document** in its head.
- Full text is persisted (anchor + diff). Digests are deterministic; a model digest is allowed only for text over 8,000 chars, at most one per stream per 10 minutes.
- Same-app runs fold into **session arcs** bounded by a 30-min idle gap.
- Element roles are captured so "the user is typing here" is a real signal.
- Stream identity: **app session** (bundle id + idle gap).
- Consent copy says what is captured and what never is. An explicit "Record from now on" step follows the Accessibility grant.

### 5.4 Writing / drafts — a lens, not a source
- No folder watching. **Opening a document is the signal.** Content comes from the browser (Roughdraft's `?path=`) and the accessibility walk.
- `write.session` fires when (i) the URL matches a registered local-editor pattern, or (ii) the focused element is editable, the trigger is a typing pause, and ≥40 new chars were inserted.
- Stream identity: **the document path.** Event carries start/end, added/removed counts, added text in order, a content-addressed snapshot ref, `is_own_writing: true`.
- Scope: folder + app **allowlist, empty by default**. Never a denylist. Never `.env`, `.ssh`, keys or `.git`.
- **R1** — a writing event reaches understanding only after 10 min idle and the document still exists.
- **R2** — assist may name a draft (title, days, word counts) and never quote it. Chat may quote when asked.

### 5.5 Not in v1
- Local OCR for accessibility-poor apps (design in `docs/product-redesign-v2.md` §5.3). Ships only if Screen Recording permission is accepted as a product cost.
- Vision-model screenshots. Never by default.
- Google Takeout import for browsing older than ~90 days.
- New sources (Claude Code JSONL, YouTube, X, ChatGPT, Gemini, Instagram).

---

## 6. Understanding

### 6.1 The call unit is time, not stream

| Mode | Unit | Rule |
|---|---|---|
| **Backfill** | one calendar day, all sources | oldest → newest so each day sees prior days' episodes. Split an oversized day at its largest inactivity gap. Never nudges. |
| **Live** | one flush | idle **45 s**, max age **120 s** (×2 backoff under sustained activity, capped by the freshness setting), max **20,000 chars**. **Express** on intent regex + ≥2 events, 120 s debounce. Floor: ≤1 non-express flush per 30 s. |

- A repeated content hash neither resets the idle timer nor counts toward the flush.
- Do **not** use windows under ~2 min: cross-source co-occurrence, the whole reason to batch, collapses.
- Bundles are rendered in temporal order, **sectioned by stream** (`[STREAM S1: wa:family]`, `[STREAM S2: browser goibibo.com]`). Every event head carries time, source, and app/title/doc where present.
- Truncation per event is budgeted from the remaining bundle allowance (floor 400, ceiling 4,000 chars), never a fixed slice.

### 6.2 Commit rules

1. Episode membership is **explicit rows**, never a rowid range.
2. An episode belongs to **exactly one stream**, derived from its resolved events. The model tags it; code enforces it.
3. **Per-item salvage.** Valid items commit. Only invalid items are repaired or quarantined. The cursor advances on event ids, never on whole bundles.
4. Critic grades the understanding output and adds a mechanical coverage check: every alias appears in exactly one of episodes / unsorted.
5. Everything committed cites events.

### 6.3 Stream identity survives as identity, not as the call unit
Per-source keys (chat JID · domain+day · app session · document path) are used for thread history, retrieval and the UI. They no longer decide what goes in a call.

---

## 7. One lane

### 7.1 One call, two payloads
The live flush makes **one** model call whose output has two independent sections: `understanding` (episodes, proposals, unsorted, questions — same shape as today's Orient) and `assist` (intent, confidence, helpfulness, urgency, deadline, action, artifact type, `grounded_in`, space hint, reasoning).

The pack includes what neither pass has today together: **episodes and spaces**, **open tasks**, and **the current time**. This is what makes *"he is booking a villa and the advance is due at 5 pm"* possible.

### 7.2 Rules
1. Sections are parsed **independently**. A bad `assist` never blocks a commit; a bad `understanding` never blocks a nudge.
2. `grounded_in` must resolve to events **in this flush**. Five events from three weeks ago cannot fire a nudge today.
3. The trigger gate moves to the **output side**: the call always happens; the gate decides "may we interrupt" using the same thresholds, evaluated in code.
4. `urgency` + `deadline_at` may override quiet hours. Nothing else may.
5. **Backfill never nudges** — enforced twice: the backfill prompt omits the assist instruction, and code discards any assist section outside the live lane.
6. Critic runs on the understanding half only, in parallel with the executor, so a nudge never waits on it.
7. Risk classes are unchanged and structural: the executor's tool table is frozen and asserted. Unification adds no capability.
8. The live lane has its **own reserved concurrency**. A backfill wave can never queue a nudge.

### 7.3 Ship gate
The unified lane replaces the separate assist lane only when: the understanding golden set **matches or beats the frozen baseline**; the assist set matches or beats it; the CROSS-N50 fixture yields one space, two episodes and **exactly one** nudge citing both sources; and a backfill bundle with a stale "pay by 5 pm" emits **zero** assist output. Fallback: shared pack, two calls.

---

## 8. Retrieval

1. FTS recall — top ~2,000 by bm25 (index-bound, does not degrade with corpus size).
2. Cosine rerank on those candidates only.
3. Neighbourhood expansion.
4. Cite by archive id.

Never a full vector scan. Never dispatches, never writes.

---

## 9. Transport and spend

### 9.1 Transport
The model is reached through the local CLI on the user's subscription with: 5-minute cache TTL, no session persistence, our prompt sent once, per-call `--max-budget-usd`, safe mode, strict MCP config (no connector names leave the machine). Target **≤ $0.006 per call**. Replacing the default agent prompt (stage 3, ~$0.002) requires one full eval pass first. Direct API is not in v1.

### 9.2 Spend rails
1. Hard ceilings at the single spawn site: **$3/hour, $15/day, 400 calls/hour, 3,000 calls/day**. Breach throws before spawning, latches, and requires an explicit user reset. Interactive chat and the grounded bar are counted but exempt from the latch.
2. A per-minute spend heartbeat in the operator log.
3. "Stop all model activity" — persisted, survives restart, does not self-resume.
4. Circuit breaker: 10 consecutive non-refusal failures on a lane pauses it 30 min and raises a banner.
5. Every background call is metered into the quota window.

### 9.3 Cost targets (stage-2 transport, Critic included)

| | Calls | Cost |
|---|---|---|
| First run, 30 days, all sources | ~45 | ~$0.26, ~4 min |
| First run, 90 days | ~135 | ~$0.77, ~12 min |
| Index everything (no model) | 0 | $0 |
| Understand 8 y of WhatsApp (opt-in) | ~3,300 | ~$19, ~5 h |
| Steady month, no screen | ~63/day | ~$11 |
| Steady month, screen "Balanced" (600 s cap) | ~115/day | ~$20 |
| Steady month, screen "Live" (300 s cap) | ~192/day | ~$33 |

---

## 10. Safety invariants (asserted by tests, forever)

1. No re-dispatch path may route more bundles per tick than the slot cap.
2. In-flight work is keyed; the same bundle is never submitted twice.
3. Every bundle is re-validated at execution; already-processed rows make zero calls.
4. A bundle is attempted at most 3 times, with backoff, then dead-lettered and shown in ops. Never retried silently forever.
5. The pool waiter queue is bounded; overflow is rejected, not queued.
6. The worker exits within 10 minutes of losing its parent, unless explicitly headless.
7. The worker refuses to boot against the real home unless launched by the app or explicitly waived.
8. The dev worker runs on a scratch home, a non-production port, with a PID file and a lifetime cap.
9. A worker startup sweep kills any pre-existing worker.
10. Trace coverage is 100%. A call site without a trace throws in dev.
11. Eval data never enters the production database; eval-origin rows are excluded from dispatch.
12. No assist section is honoured outside the live lane.
13. Deleting a source cascades to everything derived from it.

---

## 11. Settings the user sees

| Setting | Values | Default |
|---|---|---|
| Per source: connect / pause / disconnect / delete | — | disconnected |
| Per source: UNDERSTAND window | 1d · 3d · 7d · 30d · 90d · 180d · 1y · all | 30d |
| Per source: INDEX everything | on / off | on |
| Screen freshness | Live (300 s cap) · Balanced (600 s cap) | **Balanced** |
| Screen text retention | 7d · 30d · 90d · forever | 90d |
| Writing allowlist (folders, apps) | list | empty |
| Quiet hours | window | 23:00–08:00 |
| Stop all model activity | on / off | off |
| Spend ceilings | $/hr, $/day, calls/hr, calls/day | §9.2 |

---

## 12. Decisions taken by default

These were open in `docs/product-redesign-v2.md` §8 and are settled here by default. Change them and the spec changes; nothing else needs to.

| # | Question | Default taken | Why |
|---|---|---|---|
| D1 | Screen freshness | **Balanced** (600 s) | ~$20/mo vs ~$33/mo; nudges are unaffected either way |
| D2 | Does deep history ever get understood? | **Yes, opt-in, as a resumable background job** | Backfill must be pausable/resumable anyway; the job is the same code |
| D3 | Ask for Screen Recording (OCR)? | **Not in v1** | A new, scarier permission; mitigations are not guarantees. Allowlist machinery ships, toggle does not |
| D4 | Shortening UNDERSTAND | **Understanding stays, labelled, one-click delete** | It is a true record; silent erasure rewrites history |
| D5 | Transport | **CLI, stage 1+2 now; stage 3 after an eval pass; direct API not in v1** | Keeps subscription billing and local-first |
| D6 | Events captured without consent so far | **Back up the database, then start empty** | Nothing in it was consented to; re-import costs ~$1–2 |

---

## 13. Out of scope for v1
OCR, vision, Takeout import, direct API, new sources (see §5.5), multi-user, sync, mobile.
