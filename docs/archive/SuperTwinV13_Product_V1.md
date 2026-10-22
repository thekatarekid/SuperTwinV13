# SuperTwinV13 — Product V1
A Mac app. An AI digital twin that captures your data, understands your life, and acts for you — up to (never past) the risky step. Built by forking SuperTwinV11 and replacing its middle and its face.

Sources in V1: WhatsApp, screen (accessibility tree), browser history + bookmarks. Single user. Intelligence runs on the user's Claude Code CLI subscription.

* * *
## 1. Glossary
Read this first. Every term below is used with exactly one meaning in this document.

1. **Event** — one atomic captured thing (a message, a screen snapshot, a browser visit, a user tap in our app). Immutable. Append-only.
  
2. **Event log** — the single append-only SQLite store of all events. The only source of truth. Everything else can be rebuilt from it.
  
3. **Stream** — a source-native container events belong to. WhatsApp chat, an (app, document) pair, a browser tab-chain. Identified by a `stream_key`.
  
4. **Segment** — a bundle of new events from ONE stream, grouped by deterministic code (time gaps, boundaries). A segment is a **delta** — a unit of new data, not a unit of understanding.
  
5. **Episode** — a topic-coherent unit of memory, produced by the brain from segments. Usually 1 segment = 1 episode. A multi-topic segment splits into several episodes. A continuation joins an existing open episode. Episodes are the atom that gets filed into spaces.
  
6. **Space** — a goal-oriented container. "Goa trip with Rohan in December". Holds episodes, tasks, milestones, claim references, a plan. Belongs to one life area.
  
7. **Life area** — top of the hierarchy. Fixed starter list (~10: Health, Money, Work, Travel, Home, People, Shopping, Entertainment, Learning, Admin). User-editable.
  
8. **Milestone** — an intermediate stage inside a space, only where the goal is genuinely multi-step over time.
  
9. **Task** — an actionable item inside a space (or the Inbox if unfiled). Has a category and a risk class.
  
10. **Claim** — one structured statement about a person: fact, preference, belief, opinion, interest, habit, recommendation, workflow. Carries evidence. Feeds Profile and Personal CRM.
  
11. **Evidence** — a checkable pointer: `{event_ids, verbatim_quote, source, timestamp}`. Nothing gets written to the world model without at least one.
  
12. **World model** — the derived state: spaces, tasks, claims, profile, CRM, entity graph. Disposable and rebuildable from the log.
  
13. **Brain tick** — one wake of the intelligence layer. Processes one dispatched batch through four passes: Orient → Critic → Extract → Decide.
  
14. **Pass** — one single-shot LLM call inside a tick. One prompt in, one JSON schema out. No tools, no turns.
  
15. **Orient** — the pass that turns segments into episodes and files them into spaces (match / propose / unsorted).
  
16. **Critic** — the cheap adversarial pass that grades every Orient write before commit.
  
17. **Extract** — the pass that pulls claims from committed episodes.
  
18. **Decide** — the pass that extracts tasks, detects task closure, and updates the space plan.
  
19. **Executor** — the agentic loop (multi-turn, tools) that performs one task. The only unbounded-ish AI in the system.
  
20. **Risky step** — payment, transaction, sending a message/mail. Executed only after user approval, only after the result reaches acceptance level.
  
21. **Acceptance level** — checkable "definition of done" criteria the executor writes at planning time and must satisfy before the risky step is even offered.
  
22. **Dispatcher** — deterministic code that wakes the brain only when there is work.
  
23. **Coalescing** — pooling tiny closable segments so they ride with siblings instead of being processed alone.
  
24. **Age band** — backfill policy tier by event age: 0–30d, 1–6mo, 6mo–2y, 2y+. Decides what the pipeline extracts.
  
25. **Consolidation** — the merge/split/dormancy/compression work. Three tiers: inline, rolling, deep.
  
26. **Golden set** — hand-labeled eval cases run against real model calls. Grows from user corrections. Gates every prompt change.
  
27. **Unsorted** — holding area for episodes that match no space and justify no new one. Reviewed again on every space birth.
  
28. **Sweep** — retrieval + review that runs when a space is created, pulling in related past episodes (from unsorted and from the log).
  
29. **Bridge** — a deterministic cross-source join key: same URL, phone number, order id, email seen in two sources.
  
30. **Stream tier** — cheap classification of a stream: personal / group / business / transactional. Routing and extraction policy signal.
  

* * *
## 2. Design principles
Derived from measured post-mortems of V1–V11. These are non-negotiable and every eval enforces at least one.

1. **Deterministic code decides whether to spend a model call.** Gates, dedup, dispatch, segmentation are free code. The cheapest AI call is the one skipped.
  
2. **Pipeline AI is single-shot, schema-out.** One prompt in, structured output out. Agents run only where a human waits (task execution) or on schedule (deep consolidation).
  
3. **Every LLM call sees ≥20 messages of ONE conversation** plus the current state of the thing it is updating. V11 failed with a median of 1 message per call. V1 failed with 100 events across 58 chats per call. Both extremes are banned.
  
4. **Routing is retrieval, never enumeration.** A pass sees the top 3–5 candidate spaces WITH exemplar content, never a list of 74 bare names. Prompt size stays constant as spaces grow.
  
5. **Segment = delta. Understanding = delta + context.** The unit of new data and the unit of comprehension are different things, assembled at prompt time.
  
6. **≥95% of events must reach a container.** Orphaned events are a monitored, alarmed metric. (V11 silently orphaned 85%.)
  
7. **Every prompt has a verified production caller.** A subsystem that passes tests but is never invoked is a defect class. A "liveness" check asserts each pass ran in the last N ticks.
  
8. **Evals call the real model.** Frozen-response replay tests the parser, not the product. Golden evals run live calls and score behavior, with named failure modes asserted absent.
  
9. **A wrong merge destroys; a wrong split is repairable.** Below confidence 0.6, prefer new/unsorted over attach. Prefer flag over act.
  
10. **Unknown beats wrong.** Subjects, dates, amounts: emit `unknown` + a question rather than a guess.
  
11. **Privacy is enforced at capture.** What never enters the log never leaks. Post-hoc redaction is theatre.
  
12. **Risky steps are code-gated, not prompt-gated.** The WhatsApp daemon refuses to send without a signed approval token. The guarantee lives in code.
  

* * *
## 3. System overview
```
   WhatsApp          Screen              Browser              App UI
   (whatsmeow     (AX tree on          (history DB,        (every user
    daemon,        screen switch,       bookmarks file)     interaction)
    r/w gated)     link/file fetch)         |                   |
       |                |                   |                   |
       v                v                   v                   v
  ┌─────────────────────────────────────────────────────────────────┐
  │ GATES (deterministic): hash dedup · idle check · incognito drop │
  │        password-window drop · min-content floor                 │
  └───────────────────────────────┬─────────────────────────────────┘
                                  v
  ┌─────────────────────────────────────────────────────────────────┐
  │ EVENT LOG (append-only SQLite) — the single source of truth     │
  └───────┬─────────────────────────────────────────────────────────┘
          v
  ┌──────────────────┐    ┌──────────────────────────────────────┐
  │ ENRICH (lane E)  │    │ SEGMENTER (code): group by stream,   │
  │ captions, audio  │    │ close on gap/boundary/cap, coalesce  │
  │ transcripts,     │    └───────┬──────────────────────────────┘
  │ link scrape      │            v
  └──────────────────┘    ┌──────────────────────────────────────┐
                          │ DISPATCHER (code): wake brain only   │
                          │ if closable queue non-empty; urgent  │
                          │ fast-path; 10-min max latency        │
                          └───────┬──────────────────────────────┘
                                  v
  ┌───────────────────── BRAIN TICK (Claude Code CLI) ─────────────┐
  │                                                                │
  │  ORIENT ──> CRITIC ──commit──> EXTRACT (claims)                │
  │  segments    grades      │                                     │
  │  → episodes  every       └───> DECIDE (tasks, closure, plan)   │
  │  → spaces    write                                             │
  │                                                                │
  └───────┬───────────────────────────────────────┬────────────────┘
          v                                       v
  ┌──────────────────┐                   ┌──────────────────────┐
  │ WORLD MODEL      │<──── writes ──────│ CONSOLIDATION        │
  │ spaces · tasks   │                   │ T1 inline · T2 flag/ │
  │ claims · profile │                   │ rolling · T3 deep    │
  │ CRM · entities   │                   └──────────────────────┘
  └───────┬──────────┘
          v
  ┌──────────────────┐        ┌───────────────────────────────────┐
  │ EXECUTOR (agent) │───────>│ UI: menu bar + liquid-glass home  │
  │ plan→act→verify  │        │ sections · modals · grounded bar  │
  │ risk gate at end │<───────│ approvals · generative results    │
  └──────────────────┘        └───────────────┬───────────────────┘
                                              v
                              every interaction → EVENT LOG  (loop)
```

* * *
## 4. Capture
### 4.1 Two capture modes, one schema
1. **Backfill** — user picks a range: 1d, 3d, 1w, 30d, 90d, 180d, 1y, 2y, 3y, 4y, 5y, Everything. Runs as a resumable background job with a progress watermark. Processed at lower priority than live.
  
2. **Steady state** — continuous capture, forever.
  
3. Every event carries `origin: live | backfill` and an `age_band` computed from its timestamp.
  
4. Backfill watermark rule (a V11 bug class): history arrives in waves. The watermark only advances when the source confirms a wave is complete, and a periodic orphan scan re-queues any event not yet in a segment. Target: ≥95% containment.
  
### 4.2 Age-banded backfill policy
Old events matter differently. The pipeline treats them differently.

| Band | Age | What is extracted | What is NOT |
| --- | --- | --- | --- |
| A   | 0–30d | Everything: spaces, tasks, claims, closures | —   |
| B   | 1–6mo | Spaces, claims, recurrences; tasks only with still-open evidence | Stale tasks |
| C   | 6mo–2y | Claims, profile, CRM, recurrences (renewals, birthdays), major life events | Tasks (except recurrence templates) |
| D   | 2y+ | Coarse claims, relationships, life narrative, preferences | Tasks, spaces (unless clearly still alive) |

1. Band D is processed at chat-month granularity: one batched summary call per chat per month, not per segment. ~100x cheaper; old data does not deserve segment resolution.
  
2. The recurrence detector runs across all bands. A 1-year-old insurance renewal in band C becomes next month's suggested task in band A.
  
3. Dispatcher tags each batch with its band. Orient and Decide receive the band policy as a hard instruction.
  
### 4.3 WhatsApp
1. Reuse the Go daemon: read path unchanged. whatsmeow client, NDJSON over stdio (commands in on stdin: `start_pairing`, `import`, `extend`, `pause`, `resume`, `logout`, `shutdown`; events out on stdout). Pure-Go SQLite, self-contained binary.
  
2. Range enum extends to 2y/3y/4y/5y. Honest UI: whatsmeow returns what the phone has locally plus best-effort on-demand history paging. "5 years" is a request, not a promise.
  
3. **Mock mode** (`--mock`): replays a synthetic fixture through the same protocol — fake pairing, fake backfill with progress, media to disk. Used for development and CI without a real account. Kept.
  
4. **Write path (new in V13):** a `send_message` command is added to the daemon. It executes only when the command carries a valid single-use approval token minted by the UI at tap-time. No token → hard refusal in Go code. The brain drafts messages (drafts are events); it can never send.
  
5. Media (images, voice notes, video, links) is downloaded and enriched (see §4.6).
  
### 4.4 Screen (accessibility tree)
1. Trigger: capture the AX tree of the frontmost window on every **screen switch** — app switch, window switch, tab switch — plus typing-pause and scroll-stop, plus a periodic fallback (~60s) while the same window stays active.
  
2. Idle short-circuit: no keyboard/mouse input → no capture. Most of a 24/7 recorder's hours are idle; they must cost zero.
  
3. Dedup before write: tree hash, then content hash. Unchanged screen → no event.
  
4. Store diffs, not dumps: `new_chars` against the previous snapshot of the same stream. The full text lives once; snapshots reference it.
  
5. **Enrichment via references, not pixels:** when the tree shows links, files, images, or media alongside text, fetch the target directly (scrape the URL, read the file, caption the image) and attach it to the event. No screenshots in V1. Screenshot/vision pipeline stays on the backlog as a source expansion.
  
6. Privacy at capture: (a) incognito/private browser windows are detected via window attributes and never captured; (b) password manager windows (1Password, Keychain Access, etc.) are blocklisted — their content never enters the log. This is about pixels/AX text only; it does not conflict with cookie import for the future built-in browser (§4.5.4).
  
### 4.5 Browser
1. **Primary: local history DBs** (Chrome, Safari, Arc — SQLite files). Zero user friction, covers all installed browsers. Captured: URL, title, visit time, visit count, transition type (typed/link/reload), referrer.
  
2. Bookmarks: watch the bookmarks file (Chrome JSON, Safari plist) for changes; each add/remove is an event.
  
3. What we get without an extension: dwell time (derived from visit deltas + screen capture focus), full page text (from the AX capture when the browser is frontmost, linked by timestamp+URL — never duplicated), repeat-visit counts (URL-hash dedup, store the count). An extension adds only background-tab text; it stays on the backlog.
  
4. Incognito: history DBs never contain it; AX capture drops private windows. Nothing to clean up because nothing gets in.
  
5. **Future built-in browser (later phase):** session continuity comes from importing cookies/session storage from the user's browser profile with explicit consent (Chrome encrypts its cookie DB with a Safe Storage key in the macOS Keychain — readable with user permission), or a dedicated profile the user logs into once. We store sessions and cookies, never raw passwords.
  
### 4.6 Enrichment (lane E — reused from V11)
1. Images → captions (batched through the CLI with `Read` tool allowed, id echo-back verification, batch split on mismatch).
  
2. Voice notes / audio → local whisper.cpp transcripts (zero tokens, with silence/loop/wps hallucination guards).
  
3. Links → scraped page text. YouTube → captions.
  
4. Enrichment never blocks text understanding: pass 1 runs with `[image, description pending]` placeholders; when a segment's pending count hits zero, exactly one re-understand job is filed.
  
### 4.7 App UI capture
1. Every user interaction with SuperTwin itself is an event: open, dwell, expand, approve, reject, edit, dismiss, snooze, reorder, ignore, search query, chat message.
  
2. Weighting is fixed downstream: explicit feedback > edits > dismissals > passive views. A non-click is a weak signal, not a rejection.
  

* * *
## 5. Event log and segments
### 5.1 Event envelope
Every event, from any source, has the same envelope. Payloads are typed per `kind`.

```
event {
  id            ulid            // sortable, unique
  ts            utc timestamp   // when it happened (not when captured)
  captured_at   utc timestamp
  source        wa | screen | browser | app | executor
  kind          e.g. wa.message | wa.reaction | screen.snapshot |
                browser.visit | browser.bookmark | app.interaction |
                decision | approval | draft
  origin        live | backfill
  age_band      A | B | C | D
  stream_key    chat JID | app¦doc key | tabchain id | ui surface
  actor         who did it (contact id, self, system)
  payload       typed JSON (schemas below)
  content_hash  sha256 — dedup + idempotency
  blob_refs     [media file ids]
}
```
### 5.2 Example events
WhatsApp message:

```json
{ "id": "01J9Q...", "ts": "2026-08-25T19:42:10+05:30", "source": "wa",
  "kind": "wa.message", "origin": "live", "age_band": "A",
  "stream_key": "9198xxxx-1602@g.us", "actor": "contact:rohan",
  "payload": { "text": "guys lets lock goa 18-21 dec, flights are cheap rn",
               "reply_to": null, "msg_type": "text" },
  "content_hash": "9f2c...", "blob_refs": [] }
```

Screen snapshot (diff):

```json
{ "id": "01J9R...", "ts": "2026-08-25T19:48:03+05:30", "source": "screen",
  "kind": "screen.snapshot", "origin": "live", "age_band": "A",
  "stream_key": "com.google.Chrome¦tab:goibibo.com", "actor": "self",
  "payload": { "app": "Chrome", "window_title": "Goibibo · Goa hotels 18–21 Dec",
               "url": "https://goibibo.com/hotels/goa?in=2026-12-18",
               "new_chars": 1840, "before_chars": 0,
               "text_ref": "snap:8812", "links_seen": ["...villa-anjuna..."],
               "trigger": "tab_switch" },
  "content_hash": "c41a...", "blob_refs": [] }
```

Browser visit:

```json
{ "id": "01J9S...", "ts": "2026-08-25T19:47:58+05:30", "source": "browser",
  "kind": "browser.visit", "origin": "live", "age_band": "A",
  "stream_key": "tabchain:chrome:8842", "actor": "self",
  "payload": { "url": "https://goibibo.com/hotels/goa?in=2026-12-18",
               "title": "Goa hotels 18–21 Dec", "transition": "link",
               "referrer": "https://google.com/search?q=goa+hotels+december",
               "visit_count": 3 },
  "content_hash": "77b0...", "blob_refs": [] }
```

App interaction:

```json
{ "id": "01J9T...", "ts": "2026-08-25T21:02:11+05:30", "source": "app",
  "kind": "app.interaction", "origin": "live", "age_band": "A",
  "stream_key": "ui:review_queue", "actor": "self",
  "payload": { "action": "approve", "target_type": "space_proposal",
               "target_id": "sp_goa_dec", "dwell_ms": 5400 },
  "content_hash": "e19d...", "blob_refs": [] }
```
### 5.3 Segment structure
```
segment {
  id             ulid
  source         wa | screen | browser
  stream_key     same keys as events
  state          open | closable | dispatched | processed
  opened_at, last_event_at, closed_at
  close_reason   gap | day_boundary | max_cap | window_closed | urgent
  event_ids      [...]
  stats          { events, chars, new_chars, participants }
  predecessor_id nullable — links forced-close parts
}
```
### 5.4 Segment close policy
1. A segment stays **open** and accumulates while its stream is active. A 2-min ticker only checks close conditions; it never cuts.
  
2. Close conditions per source (defaults; per-stream cadence is learned over time from median reply gaps):
  

| Source | Gap close | Also closes on |
| --- | --- | --- |
| WhatsApp DM | ~6h silence | local-midnight day boundary, 40 events, 24k chars |
| WhatsApp group | ~4h silence | participant-shift, same caps |
| Screen | window closed or ~15min unfocused | 2h max-open cap |
| Browser | ~30min chain gap | tab closed, 2h cap |

3. **Max-open cap**: a 6-hour work session force-closes at ~2h as "part 1"; the successor segment carries `predecessor_id` and the brain sees part 1's summary as context.
  
4. **Urgent fast-path**: a cheap deterministic check (today-dated deadline words, payment words, direct question to self) flags an event; its segment dispatches immediately with `close_reason: urgent`.
  
5. **Coalescing**: closable segments under a signal floor (e.g., <3 events and <200 chars) are pooled per stream and ride with the next sibling segment or flush together at tick time.
  
6. **The 1-message segment is not a quality problem.** Segments are deltas. The brain never sees a segment naked — context assembly (§6.3) attaches ≥20 messages of thread history and current space state. The failure to avoid is starving the model, not small deltas.
  
### 5.5 Example segments
```json
{ "id": "seg_wa_4451", "source": "wa", "stream_key": "9198xxxx-1602@g.us",
  "state": "closable", "opened_at": "19:42", "last_event_at": "20:15",
  "close_reason": "gap", "event_ids": ["01J9Q...", "...12 more"],
  "stats": { "events": 13, "chars": 1450,
             "participants": ["rohan","aditya","tanvi","k1"] },
  "predecessor_id": null }
```

```json
{ "id": "seg_scr_9921", "source": "screen",
  "stream_key": "com.google.Chrome¦tab:goibibo.com", "state": "closable",
  "opened_at": "19:47", "last_event_at": "20:09",
  "close_reason": "window_closed",
  "event_ids": ["01J9R...", "...9 more"],
  "stats": { "events": 10, "chars": 0, "new_chars": 9200 },
  "predecessor_id": null }
```

Note: the user was also editing a work doc and playing YouTube music in the same 30 minutes. Those are different stream keys → different segments. Interleaving in time never merges streams.
### 5.6 Why segments are single-source
1. Deterministic code groups only by structural keys it cannot get wrong: chat JID, (app, document), tab chain.
  
2. Cross-source grouping requires meaning. Time-window joins lie: hotel browsing during a work chat is the same minute, unrelated topics.
  
3. The rule: the deterministic layer never guesses. The brain links across sources with evidence (shared space, entity match, bridge keys like same URL/phone/order-id), where a mistake is visible, reviewable, reversible.
  
4. Segments stay replayable and unit-testable forever.
  

* * *
## 6. Dispatch and the brain tick
### 6.1 Dispatcher (deterministic)
1. Watches the closable-segment queue — the list of segment ids whose close condition fired.
  
2. Empty queue → the brain never wakes. Non-empty → wake Claude Code, batch everything pending, grouped by stream then by space affinity.
  
3. Max-latency timer guarantees the 10-minute freshness bound even under constant trickle.
  
4. Urgent-flagged segments bypass the batch window.
  
5. An open segment receiving new events just extends; it is dispatched once, at close. Successor segments (after force-close) are new dispatches that carry predecessor context.
  
### 6.2 Tick anatomy
One tick = one dispatched batch through four **separate single-shot CLI calls**. Not a conversation. Each pass has its own system prompt and its own packed context. All passes share one byte-identical preamble (schema legend) so prompt caching works.

```
        ┌────────┐     writes      ┌────────┐   commit   ┌─────────┐
 batch ─│ ORIENT │────────────────>│ CRITIC │───────────>│ EXTRACT │─> claims
        └────────┘  (uncommitted)  └────────┘     │      └─────────┘
                                                  │      ┌─────────┐
                                                  └─────>│ DECIDE  │─> tasks,
                                                         └─────────┘   closures,
                                                                       plan
```

1. Dependency order: Critic grades Orient. Extract and Decide run on committed episodes, in parallel.
  
2. CLI discipline (kept from V11, verified): prompt on stdin, `--output-format stream-json`, bare-call contract (no tools, `--max-turns 1`, empty settings sources, tmp cwd), one repair round on malformed output, then quarantine — model output is never silently discarded.
  
3. Model routing: Orient/Extract/Decide on sonnet-class; Critic on haiku-class. Per-role model selection is a setting (reused from V11 settings system).
  
### 6.3 Context assembly (the anti-starvation layer)
Deterministic packer builds each pass's context. Rules:

1. Every call sees ≥20 events of ONE stream (thread history fills around the delta), plus the current state of the thing being updated.
  
2. Candidate spaces come from **retrieval, not enumeration**: top 3–5 by entity overlap + keyword/FTS + embedding + recency, each shown with label, goal, life area, and 2–3 exemplar episode summaries. Never a bare-name list.
  
3. Related episodes from other sources ride in when entity or bridge keys match (same URL, phone, order id, person).
  
4. Open loops of the affected space(s) and roster (participants with resolved names) are always present.
  
5. Prompt size stays roughly constant regardless of how many spaces exist.
  

* * *
## 7. The four passes — prompts
Conventions for all passes:

1. Output is strict JSON, one object, no prose. Malformed → one repair round → quarantine.
  
2. Every written object carries `evidence: [{event_ids, quote}]` and `confidence: 0..1`.
  
3. `confidence < 0.6` on attach → prefer new/unsorted. Unknown beats wrong.
  
4. Every decision (input ids, output, justification, confidence, model, prompt version) is stored in a `decisions` table and shown in the UI under "why?".
  
5. The shared preamble (identity + JSON schema legend) is byte-identical across calls of the same pass — cache-friendly.
  
### 7.1 ORIENT — episodes + filing
**System prompt (core, abridged):**

```
You are SuperTwin's Orient pass. You turn new data (a segment) into
episodes and file each episode into the user's spaces.

Definitions:
- Episode: a topic-coherent unit. One segment is usually one episode.
  Split ONLY if the segment clearly covers unrelated topics. When you
  split, assign message ranges, never single messages, to each episode.
- A continuation of an open episode should JOIN it, not start a new one.

Filing, in strict order per episode:
(a) MATCH: does it belong to one of the candidate spaces? Attach if the
    evidence supports it. confidence < 0.6 → do not attach.
(b) PROPOSE: only if no match AND there is real goal evidence — explicit
    intent, commitment, plan-making, money, dates, or repeated engagement
    across ≥2 segments or sources. One-off curiosity is NOT a space.
    Proposals include space type fields and a 4–8 word specific label
    (BAD: "Goa trip". GOOD: "Goa trip with Rohan in December").
(c) UNSORTED: otherwise. Unsorted is a good answer. A wrong merge
    destroys; a wrong split is repairable.

Rules:
- Never create one space per chat. Chats are streams, not topics.
- Never split a single conversation topic across multiple new spaces.
- Every output carries evidence quotes and event ids.
- Age-band policy in context is a hard constraint.
- Answer in the JSON schema only.
```

**User prompt (assembled by packer):**

```
[BAND] A (live)
[ROSTER] self=Aditya · rohan=Rohan Mehta · tanvi=Tanvi S · k1=Karan
[STREAM] wa · group "Goa gang" (tier: personal-group)
[THREAD HISTORY] last 22 messages (read-only context) ...
[OPEN EPISODES in this stream] ep_881 "Diwali gift pool" (dormant 6d)
[CANDIDATE SPACES]
 1. sp_goa_dec "Goa trip with Rohan in December" · Travel ·
    goal: plan 18–21 Dec Goa trip · exemplars: "flights CCU-GOI compared",
    "villa shortlist discussed"
 2. sp_diwali "Diwali gifts for family" · People · exemplars: ...
 3. (none within retrieval floor)
[RELATED FROM OTHER SOURCES] browser tabchain 8842: goibibo Goa hotels
 18–21 Dec (bridge: dates+destination)
[NEW SEGMENT seg_wa_4451] 13 events:
 e1 19:42 rohan: guys lets lock goa 18-21 dec, flights are cheap rn
 e2 19:44 tanvi: im in. also did anyone pay the diwali pool??
 e3 19:45 self: paying pool tonight. rohan share flight link
 ... (10 more)
```

**Expected output (example):**

```json
{ "episodes": [
    { "action": "attach", "space": "sp_goa_dec",
      "events": ["e1","e3","e4-e11"],
      "summary": "Group agreed on 18-21 Dec Goa dates; Rohan to share flight link.",
      "evidence": [{"event_ids":["e1"],"quote":"lets lock goa 18-21 dec"}],
      "confidence": 0.93 },
    { "action": "attach", "space": "sp_diwali", "join_episode": "ep_881",
      "events": ["e2","e3"],
      "summary": "Tanvi asked about the Diwali pool; Aditya committed to pay tonight.",
      "evidence": [{"event_ids":["e2"],"quote":"did anyone pay the diwali pool??"}],
      "confidence": 0.9 }
  ],
  "proposals": [], "unsorted": [], "questions": [] }
```

Note what did NOT happen: no new space for a conversation that touched two topics; message ranges split, one message (e3) legitimately in both episodes.
### 7.2 CRITIC — the gate
**System prompt (core, abridged):**

```
You are SuperTwin's Critic. You grade another pass's writes BEFORE they
commit. You are adversarial and precision-biased. You do not rewrite —
you verdict.

For each write, check:
1. Evidence: does the quote actually support the action?
2. Fragmentation: would this create a space where an existing space
   (or the unsorted area) is correct? Retrieved near-duplicates listed.
3. Contamination: does the attach import unrelated context into a space?
4. Confidence honesty: is the stated confidence justified?
5. Label quality (proposals): specific, 4–8 words, not generic.

Verdicts: commit | reject(reason) | downgrade_to_unsorted |
flag_overlap(space_id).
A flag_overlap does not block commit; it queues a consolidation review.
Answer JSON only.
```

**User prompt:** Orient's decisions + the retrieval list of near-duplicate spaces/episodes + the rubric thresholds. **Example output:**

```json
{ "verdicts": [
    { "ref": "episodes[0]", "verdict": "commit" },
    { "ref": "episodes[1]", "verdict": "commit",
      "flag_overlap": null } ],
  "notes": [] }
```

Why Critic is separate from Orient: a model grading its own output in the same context inherits its own errors (self-consistency bias). Orient is recall-biased by design; the Critic is precision-biased with fresh context. It is one haiku-class call per batch. If evals ever show zero lift, it can be switched off — it is a gate, not a pillar.
### 7.3 EXTRACT — claims
**System prompt (core, abridged):**

```
You extract claims about people from committed episodes.
Claim kinds: fact, preference, belief, opinion, interest, habit,
recommendation, workflow, relationship.

Rules:
- Subject MUST be a resolved roster identity, or "unknown" with a hint.
  UNKNOWN BEATS WRONG.
- Write claims in resolved third person ("Rohan prefers window seats"),
  never aliases, never first person for others.
- Each claim: kind, subject, text, confidence, valid_from,
  evidence quotes. Temporal facts carry validity.
- You also receive existing claims about the mentioned people. Emit
  updates: new | reinforces(claim_id) | contradicts(claim_id).
  Contradictions do not overwrite — a judge pass resolves supersede
  vs coexist.
- Extraction policy comes from the stream tier: transactional and
  promotional streams yield NO preference/belief claims (an ad is not
  a preference).
Answer JSON only.
```

**Example output (from the Goa episode):**

```json
{ "claims": [
    { "kind": "fact", "subject": "self",
      "text": "Planning a Goa trip 18-21 Dec 2026 with Rohan, Tanvi, Karan",
      "relation": "new", "confidence": 0.95, "valid_from": "2026-08-25",
      "evidence": [{"event_ids":["e1","e4"],"quote":"lets lock goa 18-21 dec"}] },
    { "kind": "habit", "subject": "contact:rohan",
      "text": "Tracks flight prices and initiates group trip planning",
      "relation": "reinforces:clm_2231", "confidence": 0.7,
      "evidence": [{"event_ids":["e1"],"quote":"flights are cheap rn"}] } ] }
```
### 7.4 DECIDE — tasks, closure, plan
**System prompt (core, abridged):**

```
You run per affected space, with the space's full state. You produce:

1. TASKS from the new episodes. Three types:
   - explicit: stated ("book the villa by Friday")
   - implicit: entailed ("flight at 6am" → "arrange 4am cab")
   - suggested: advances the space goal; clearly marked; max 2 per
     space per day. Suggested tasks come from PLAN GAPS.
   Every task: title, type, category (communication | transaction |
   research | scheduling | filing | creation | monitoring | errand),
   risk class (auto | approve-final | approve-first | advise-only),
   due, space, evidence, confidence.

2. CLOSURES: match new evidence against the OPEN TASKS listed.
   Two-sided/hard evidence (confirmation received, payment done,
   both parties acknowledge) → close, confidence ≥ 0.85.
   One-sided ("I'll do it tonight") → suggest_close at most.
   NEVER auto-close on intent. A false close is silent data loss.

3. PLAN: if the space is new or materially changed, update
   goal → milestones (only if genuinely multi-step) → next actions.

Age-band policy is a hard constraint (band C/D: recurrence
templates only, no live tasks).
Answer JSON only.
```

**Example output:**

```json
{ "space": "sp_goa_dec",
  "tasks": [
    { "title": "Book flights CCU-GOI for 18 Dec, return 21 Dec",
      "type": "explicit", "category": "transaction",
      "risk_class": "approve-final", "due": "2026-08-29",
      "evidence": [{"event_ids":["e1","e6"],"quote":"lets lock goa 18-21 dec"}],
      "confidence": 0.9 },
    { "title": "Shortlist 3 villas near Anjuna under group budget",
      "type": "implicit", "category": "research", "risk_class": "auto",
      "evidence": [{"event_ids":["e8"],"quote":"budget 6k/night max"}],
      "confidence": 0.8 } ],
  "closures": [
    { "task": "tsk_pool_pay", "verdict": "suggest_close",
      "reason": "Aditya said 'paying pool tonight' — one-sided intent only",
      "confidence": 0.55 } ],
  "plan": { "goal": "Goa trip 18-21 Dec, 4 people, booked under budget",
            "milestones": ["dates locked ✓", "flights booked",
                           "stay booked", "itinerary set"],
            "next": ["flights (blocked on approval)", "villa shortlist"] } }
```

* * *
## 8. Spaces
### 8.1 Hierarchy
```
Life area (fixed ~10, user-editable)
  └── Space (goal-based; inferred, user-editable)
        └── Milestone / Journey (only when genuinely multi-step)
              └── Task
Claims live globally (Profile / CRM); spaces hold pointers to the
claims they rely on.
```
### 8.2 Space object
```
space {
  id, label (4–8 specific words), life_area, goal (editable),
  type: { activity: active|dormant, term: short|long,
          persistence: permanent|ephemeral, cadence: one_time|recurring,
          privacy: private (V1; shared|public later), mode: solo (V1) },
  plan { goal, milestones[], next[] },
  episodes[], tasks[], claim_refs[], enrichment[],
  created_by: proposal|user, status: proposed|active|dormant|archived
}
```

1. Type fields are set by Orient at proposal, revised by consolidation, always user-editable.
  
2. For the first months, space creation is **propose-only**: the twin proposes, the user approves in the review queue. Graduation to auto-create happens when eval metrics hold for 2+ weeks.
  
3. **Space birth triggers a sweep**: retrieval over unsorted + the log finds related past episodes (including the very message that justified creation) and files them in. Unsorted items unclaimed for 30 days archive but stay searchable.
  
4. **Population**: assigned episodes (any source) + tasks + claim pointers + web enrichment. Enrichment is executed as `auto`-class research tasks by the executor ("pull current CCU-GOI prices for 18 Dec") and lands as cards in the space.
  
5. Cross-chat / cross-source understanding accrues in the space (episodes from all streams), in the entity graph (people, orgs), and via bridges (deterministic joins on URL / phone / order id / email across sources).
  

* * *
## 9. Consolidation — continuous, tiered
1. **Tier 1 — inline, every tick.** Critic's retrieve-then-judge: before any space/task/claim is created, near-duplicates are retrieved and judged. Dupes die at write time.
  
2. **Tier 2 — flag-triggered + rolling.** Runs immediately when a Critic `flag_overlap` fires; otherwise rolls hourly over spaces touched since the last roll. Does merge / split / dormancy for that scope. Why Tier 1 can't do this: it sees one batch, not a space's whole history; whole-space review inline would slow every tick and cause space-flapping. Flags give inline _detection_ with scoped _action_.
  
3. **Tier 3 — deep, opportunistic** (machine idle + on power, roughly daily but never scheduled at a fixed hour). Full-graph pass: cross-space linking, claim compression, summary refresh, embedding refresh, archive sweep, eval regression run.
  
4. User-visible effect of Tier 3: search stays fast and accurate, dormant spaces tuck themselves away, the world model stays small (smaller context → better reasoning per tick), and quality never silently degrades — degradation-over-time is a named failure mode with a gate.
  
5. All merges/splits are recorded as decisions with evidence and are reversible (mutation log, one-tap undo).
  

* * *
## 10. Tasks and execution
### 10.1 Task object
```
task {
  id, space, title, type: explicit|implicit|suggested,
  category: communication | transaction | research | scheduling |
            filing | creation | monitoring | errand,
  risk_class: auto | approve-final | approve-first | advise-only,
  due, status: open | executing | needs_input | needs_approval |
               done | dismissed,
  evidence[], plan_ref, result_ref, decisions[]
}
```

Risk classes:

1. `auto` — fully executable. Research, filing, monitoring, drafting.
  
2. `approve-final` — execute everything; the last step (pay, send, book) needs a tap.
  
3. `approve-first` — don't start without a go-ahead (anything that spends money or contacts people during execution).
  
4. `advise-only` — physical-world errands. Remind and prep, never attempt.
  
### 10.2 Executor — the agentic loop
The only multi-turn, tool-using AI in the system. One Claude Code session per task, with an execution template per category.

```
 plan ──> criteria ──> [ gather context ──> act ──> verify ]──┐
  ^                       (world model,      |        |       │
  │                        web, ask user     |     meets      │
  │                        if missing)       |   acceptance?  │
  │                                          |     no │ yes   │
  │        blocked & can't proceed?          |        │       v
  └── replan (different route, informed <────┘        │   risky step?
      by attempt log — never fail the                 │   ├─ no → done
      same way twice; bounded attempts,               │   └─ yes → approval
      then escalate with best partial)                │        card → user tap
                                                      └───────── loop again
```

1. Planning writes **acceptance criteria** first — checkable definition of done.
  
2. The loop runs once, self-verifies against criteria, loops again if more can be done.
  
3. Blocked step → replan a different route. The attempt log (what worked, what failed, why) feeds every replan. Multiple plans allowed; bounded by attempt/budget caps; then escalate to the user with the best partial result.
  
4. **The risky step is terminal and gated twice**: it exists only after the result meets acceptance level, and it executes only on user approval (code-enforced — e.g., the WhatsApp daemon's token check).
  
5. Missing information → a question card to the user, never a guess.
  
6. Executor results are emitted as a typed result schema for generative UI rendering (§11.4).
  

**Executor system prompt (core, abridged):**

```
You execute ONE task for the user. You have tools (web, world model
read, drafts, files). You may take multiple turns.

Protocol:
1. Write a plan and explicit acceptance criteria first.
2. Execute stepwise. Gather context before acting. If required
   information is missing and not findable, emit a user question and
   pause.
3. After each cycle, verify the result against the criteria. Not met →
   improve or replan. Record every attempt's outcome in the attempt log
   and never repeat a failed approach unchanged.
4. NEVER perform: payments, sending messages/mail, bookings,
   irreversible account actions. When the result meets criteria and
   such a step remains, emit an approval request describing exactly
   what will happen on approval.
5. Emit the final result in the result schema for your task category.
Budget: max N cycles / $X. On budget exhaustion, emit best partial +
what's missing.
```
### 10.3 Task completion
Three paths, in order of trust:

1. Executor closes its own loop (criteria met, no risky remainder).
  
2. Evidence closure by Decide: hard/two-sided evidence auto-closes (≥0.85); one-sided intent caps at `suggest_close` — the "looks done — confirm?" chip. False closes are treated as data loss.
  
3. User marks done. Always available, always an event, always learned from.
  

* * *
## 11. UI
### 11.1 Shape
1. **Menu bar app** — always resident. Proactive surface: nudges, question cards, approval requests pop from here. Same design language as the main app. Quiet by default; batched, rate-limited.
  
2. **Main window** — summoned by double-tap **right ⌘** (configurable). Translucent, liquid-glass material, floats over the desktop. Esc dismisses.
  
3. **Single-screen home. Sections, not a feed.** Sections: Today (tasks + approvals), Spaces, Review queue, People, Recent understanding (what the twin just learned — dismiss/correct inline). Each section scrolls internally or expands into a larger view. No global scroll-feed.
  
4. **Modals for depth**: clicking any task/space/claim/approval opens a modal — full details, evidence quotes, "why?" (the decision record: justification + confidence + source events), history, actions.
  
5. **Grounded bar** — floating at bottom-center with an offset. One input, three behaviors: search (over all data), chat (grounded answers with citations to events), actions ("book the goa flights" → routes to executor).
  
6. Approvals: one-tap approve stays; the card expands to a modal showing exactly what will happen, the draft/amount/recipient, and the evidence trail.
  
### 11.2 Layout sketch
```
┌────────────────────────────── liquid glass ───────────────────────────────┐
│  SuperTwin                                            ◔ processing · 2m   │
│                                                                           │
│  ┌── Today ──────────────────────────┐  ┌── Spaces ─────────────────────┐ │
│  │ ▸ Approve: flights CCU-GOI  ₹18k  │  │ ● Goa trip with Rohan · Dec   │ │
│  │ ▸ Villa shortlist ready · view    │  │ ● Diwali gifts for family     │ │
│  │ ▸ Pay Diwali pool (due today)     │  │ ○ Gym restart plan (dormant)  │ │
│  │   ⋯ 4 more                        │  │   ⋯ all spaces                │ │
│  └───────────────────────────────────┘  └───────────────────────────────┘ │
│  ┌── Review queue ───────────────────┐  ┌── People ─────────────────────┐ │
│  │ ? New space: "Weekend trek plan"  │  │ Rohan · follow up on flight   │ │
│  │ ? Merge: "Goa food" → Goa trip    │  │ Ma · birthday in 12 days      │ │
│  └───────────────────────────────────┘  └───────────────────────────────┘ │
│                                                                           │
│              ┌───────────────────────────────────────────┐                │
│              │  ⌕  Ask, search, or tell me to do things  │                │
│              └───────────────────────────────────────────┘                │
└───────────────────────────────────────────────────────────────────────────┘
```
### 11.3 Menu bar states
```
 ◉ idle · ◔ processing · ● needs you (n) — click opens a compact panel:
 approvals first, then questions, then nudges. Never more than 3 nudges
 a day without engagement.
```
### 11.4 Generative UI for results
1. The executor emits `{result_type, data}` against a typed schema per category: comparison_table, itinerary, draft_preview, approval_card, research_brief, checklist, timeline, receipt.
  
2. The renderer composes the result from a **fixed component library** in the app's design system. The model chooses composition and content — never colors, fonts, or layout primitives. This is how results stay beautiful, consistent, and on-brand while being tailored per task.
  
3. Unknown/overflow content falls back to a clean document card. No raw text walls.
  

* * *
## 12. Learning loop
1. Every user interaction is an event (§4.7). Every correction is signal.
  
2. Weighting: explicit feedback > edits > dismissals > passive views. Ignoring a task 5 times is a weak demotion signal, not a rejection.
  
3. Effects by target: corrections to filing → Orient context (per-stream and per-space routing hints); task edits → Decide's extraction thresholds per category; dismissed suggestions → suggestion rate throttles; segment boundary corrections → per-stream close parameters (tuned by Tier 3).
  
4. Every correction auto-drafts a golden eval case (§13). The golden set grows from real mistakes.
  
5. All passes read from the same log, so an update is visible to every later pass in the very next tick.
  

* * *
## 13. Eval system
1. **Golden evals run the real model.** Each case: setup (world state) + input events + expected behavior + named `wrong[]` failure modes asserted absent + gates it feeds. No frozen-response replay as a release gate — that tests the parser, not the product.
  
2. Hard gates (fail = no ship): space over-creation <10% on the routing suite; zero false auto-merges; zero false auto-closes; ≥95% event containment; zero risky steps without approval token; every pass has a production caller (liveness).
  
3. Soft gates (tracked): assignment accuracy ≥90%, claim subject accuracy, suggested-task acceptance rate, cost per event.
  
4. Promotion loop: real 👍/👎/edit → correction row → auto-drafted fixture → human confirms → golden set.
  
5. Adversarial generation: paraphrase, Hinglish-ify, reorder failed cases into siblings.
  
6. The 100-case starter suite ships alongside this document (same folder), organized by pass, in exactly this format.
  

* * *
## 14. Build plan — fork of V11
### 14.1 Keep (the fork's assets)
| Asset | Where (in the V11 tree) | Why |
| --- | --- | --- |
| Claude CLI adapter | `worker/src/providers/claude-local/` | Bare-call contract, binary resolution, poison detection, token accounting — hard-won and verified |
| WhatsApp daemon + supervisor | `sources/whatsapp-go/`, `worker/src/adapters/whatsapp/` | Works; extend range enum; add token-gated send |
| Enrichment | `worker/src/media/` | Captions, whisper transcripts, link scrape, batch-split protocol — highest-value asset |
| DB layer + migrations | `worker/src/db/` | better-sqlite3, WAL, settings, runs, watermarks, mutations (undo) |
| Entities + party model | `worker/src/entities/` | Identity resolution and the 9-way party model kill "spaces that are other people's lives" |
| Claims data model | `worker/src/claims/` (tables + write path) | Kinds, evidence, supersede — matches §7.3 |
| Bridges | `worker/src/bridges/` | Deterministic cross-source joins; built, never wired — wire it |
| Stream tiers | `worker/src/tiers/` | Cheap routing + extraction-policy signal (kills ad-tasks) |
| Retrieval | `worker/src/retrieval/` | FTS + embeddings; feeds candidate-space retrieval |
| Cost accounting | `run-accounting.ts`, `providers/usage.ts` | Verified within 2.6% of hand recompute |
| Ingest + history health | `worker/src/ingest/` | Plus the orphan-scan fix (§4.1.4) |
| Scheduler skeleton | `worker/src/scheduler/` (cohorts, lanes, queue) | Becomes the dispatcher; drivers rewritten |
| Prompt runner patterns | `prompts/runner.ts`, repair/quarantine | Keep the discipline, replace the prompts |
| Release pipeline | `scripts/`, `.github/workflows/` | DMG build, sidecar staging |
| Tauri shell | `src-tauri/` | 285 LOC; add menu-bar + global-hotkey + vibrancy |
### 14.2 Delete
| Item | Why |
| --- | --- |
| `src/` (entire React UI, 12 tabs) | New UI concept (§11). The UI is cleanly severable — it only speaks HTTP/SSE to the worker. Reimplement the Ops/debug surface (quarantine browser, run undo, token split) inside the new app |
| `worker/src/sessions/`, `episodes/`, `arcs/` | The wrong middle. Replaced by segments (§5) + Orient episodes (§7.1) + spaces as first-class objects |
| The 11 V11 prompts | Replaced by the 4 passes + executor. Keep the wire/packing discipline lessons |
| Embedding calibration layer | Replace with retrieve-then-judge (never bare cosine thresholds) |
| Fixture-replay evals as gates | Golden live evals replace them (§13); keep the runner/gate plumbing |
| `evals/fixtures/` (1,000 frozen cases) | Superseded by the V13 golden suite |
| `releases/*.dmg`, `worker/dist/`, `brain-template/`, docs museum | Dead weight |
### 14.3 New builds
1. Screen recorder daemon (AX tree, triggers, dedup, privacy gates) — §4.4.
  
2. Browser watcher (history DB readers, bookmarks watcher) — §4.5.
  
3. Segmenter + coalescing + dispatcher — §5–6.
  
4. The four passes + context packer — §6.3, §7.
  
5. Consolidation tiers — §9.
  
6. Executor + execution templates + result schemas — §10.
  
7. New UI: menu bar, liquid-glass home, modals, grounded bar, generative result renderer — §11.
  
8. WhatsApp send with approval tokens — §4.3.4.
  
9. Golden eval harness (live-call) — §13.
  
### 14.4 Phases
1. **P0 — Substrate**: fork, deletions, event log + segmenter + dispatcher, WhatsApp + browser capture, orphan scan, golden harness + first 100 evals. Exit: replayable log, ≥95% containment on backfill, segments correct by inspection.
  
2. **P1 — Understanding (propose-only)**: four passes on WhatsApp + browser, review queue in a minimal window. Exit: ≥90% assignment, <10% over-creation, zero false merges/closes on the golden suite. Do not proceed until this holds.
  
3. **P2 — Screen**: AX recorder + enrichment-by-reference + screen segments into the same brain. Exit: same bars hold with screen on; ≤10-min latency.
  
4. **P3 — Tasks + executor**: Decide fully on, executor with templates, approvals end-to-end (including WhatsApp send tokens). Exit: ≥80% of surfaced tasks are real; zero unapproved risky steps.
  
5. **P4 — Full UI + graduation**: liquid-glass home, generative results, grounded bar; auto-create spaces after 2 clean weeks; Tier 3 consolidation on.
  
6. **P5 — Expansion (backlog)**: more sources, vision pipeline, built-in browser with cookie import, iPhone, shared/public spaces.
