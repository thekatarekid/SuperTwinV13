# SuperTwinV13 — Product V2
A Mac app. An AI digital twin that captures your data, understands your life, and acts for you proactively — up to (never past) the risky step. Built by forking SuperTwinV11: keep its plumbing, replace its middle and its face.

Launch sources: WhatsApp, screen (accessibility tree), browser history + bookmarks. Expansion sources (built on the SuperTwin Browser): YouTube, X, Instagram, ChatGPT, Claude, Gemini. Single user. Intelligence runs on the user's Claude Code CLI subscription.

* * *
## 1. Glossary
Every term has exactly one meaning in this document.

1. **Event** — one atomic captured thing (a message, a screen snapshot, a browser visit, a user tap in our app). Immutable, append-only.
  
2. **Event log** — the single append-only SQLite store of all events. The only source of truth; also the full timeline. Everything else is rebuildable from it.
  
3. **Stream** — WHERE events happen: a chat, an (app, document) pair, a browser tab chain. Structural, source-native, identified by `stream_key`. Streams guarantee nothing about topic — that is not their job.
  
4. **Tab chain** — one browser tab's navigation sequence (search → result → page → …), linked by tab id + referrer.
  
5. **Delta bundle** — the new events of ONE stream since that stream's cursor, cut purely by the dispatch window. Zero semantic meaning; a cursor, not a concept.
  
6. **Dispatch window** — the recurring timer interval (~5 min live; longer for backfill lanes). At each boundary the dispatcher collects every stream's delta bundle.
  
7. **Tick** — one dispatched batch of bundles flowing through the understanding passes. A scheduling unit only; never a prompt.
  
8. **Episode** — one temporal burst of coherent activity about one thing, within one stream. Created/extended ONLY by Orient. States: active ⇄ dormant (no terminal state). Same-topic bursts weeks apart = two chained episodes.
  
9. **Chapter** — a cross-stream sub-goal grouping inside a space ("Flights", "Stay", "Packing"), built by Decide from the space's episodes. Chapters with target dates ARE the milestones (one concept, not two).
  
10. **Space** — the goal itself, across all streams and sources. "Goa trip with Rohan in December". Holds chapters, episodes, tasks, plan, claim refs. Belongs to one life area.
  
11. **Life area** — top of the hierarchy. Starter list (~10: Health, Money, Work, Travel, Home, People, Shopping, Entertainment, Learning, Admin), user-editable.
  
12. **Task** — actionable item in a space. Has type (explicit/implicit/suggested), category, risk class, optional schedule.
  
13. **Claim** — one structured statement about a person: fact, preference, belief, opinion, interest, habit, recommendation, workflow, relationship. Carries evidence. Feeds Profile + Personal CRM.
  
14. **Evidence** — checkable pointer: `{event_ids, verbatim_quote, source, ts}`. Nothing enters the world model without one.
  
15. **World model** — derived state: spaces, chapters, tasks, claims, profile, CRM, entity graph. Disposable, rebuildable.
  
16. **Understanding lane** — the write path: dispatch windows → passes → gated writes to durable memory.
  
17. **Assist lane** — the fast read-and-act path: watches the last seconds of activity, proactively prepares artifacts, writes nothing durable without the gate.
  
18. **Pass** — one single-shot LLM call: prompt in, JSON out. No tools, no turns. Five passes: Orient, Critic, Extract, Decide, Digest.
  
19. **Orient** — per-stream pass: bundle → episodes (new/join/split by message range) → space filing (attach / propose / unsorted).
  
20. **Critic** — cheap adversarial pass grading every Orient write before commit. Verdicts: commit / reject / downgrade / flag_overlap.
  
21. **Extract** — pulls claims from committed episodes.
  
22. **Decide** — per-space pass: tasks, closures, chapters, plan, schedule candidates, follow-ups.
  
23. **Digest** — coarse pass for Category-2 backfill: one summary call per stream per month-chunk.
  
24. **Executor** — the agentic loop (multi-turn, tools) performing one task. Plans → acts → verifies → replans. The only unbounded-ish AI.
  
25. **Risky step** — payment, transaction, sending a message/mail, irreversible account action. Runs only after user approval AND only after the result meets acceptance level. Code-gated.
  
26. **Acceptance level** — checkable definition-of-done the executor writes at planning time.
  
27. **Roles** — per message: sender · audience (who can see) · receiver (who it's addressed to, ⊆ audience; = audience when unaddressed) · mentioned receiver (named, in audience) · mentioned third party (named, not in audience).
  
28. **Roster** — resolved participant list injected into every prompt: identities, relationships, nickname notes.
  
29. **Circle** — relationship ring in the CRM: partner · family · close friends · friends · coworkers · important services · old batchmates · acquaintances · businesses. Inferred, user-editable. Drives priority, tone, applicability — never defined by reply volume alone.
  
30. **Provisional entity** — a person created from mentions alone (no phone/email), e.g. a cousin, a kid. Merges forward when identifiers appear.
  
31. **Bridge** — deterministic cross-source join key: URL, phone, email, order id, tracking number, media id. Exact match, no model.
  
32. **Unsorted** — holding area for episodes matching no space and justifying none. Re-reviewed at every space birth and periodically. Never a grave.
  
33. **Sweep** — retrieval + review at space birth pulling in related past episodes from unsorted and the log.
  
34. **Second-look queue** — attaches committed at confidence 0.60–0.75 get re-verified in the next consolidation window.
  
35. **Category 1 / 2** — processing priority classes. Cat 1: DMs, groups the user has ever replied in, transactional business streams, everything the user actively does. Cat 2: never-replied groups, promotional streams, junk domains. Cat 2 = later + coarser, never dropped; engagement instantly promotes to Cat 1.
  
36. **Age band** — backfill policy by event age: A 0–30d · B 1–6mo · C 6mo–2y · D 2y+. Decides what gets extracted.
  
37. **Nudge** — the assist lane's proactive surface: intent + what was prepared + artifact. The popup is ephemeral; the artifact is durable and shows in the menu-bar Prepared list, the Home "Prepared for you" shelf, the owning space's banner, and the grounded bar's idle chip (§14.7.8). Frequency is gated by novelty + intent confidence (§10.1), not a daily cap.
  
38. **Grounded bar** — the floating input: search, chat (with citations), actions (create spaces/tasks, run things). Has history; can embed webviews in answers.
  
39. **SuperTwin Browser** — the app's own Chromium with one persistent logged-in profile, shared by user browsing, in-app webviews, and the agent. Also the capture engine for API-less sources.
  
40. **Trace** — the stored record of one model run: input prompt, packed context, raw output, parsed result, verdicts, tokens, cost, latency. Every run has one.
  
41. **Golden set** — hand-labeled evals run against the real model, growing from user corrections, gating every prompt change.
  

* * *
## 2. Design principles
Non-negotiable; derived from measured V1–V11 post-mortems. Every eval enforces at least one.

1. **Deterministic code decides whether to spend a model call.** Gates, dedup, dispatch, cursors are free code.
  
2. **Pipeline AI is single-shot, schema-out.** Agents run only where a human is waiting (executor, assist artifacts) or on schedule.
  
3. **Assignment per event · call per stream-delta · never a call per event.** Every call sees ≥20 events of ONE stream + the current state of what it updates. (V11 median call saw 1 message; V1 packed 100 events from 58 chats. Both banned.)
  
4. **Routing is retrieval, never enumeration.** Top 3–5 candidate spaces WITH exemplar content; prompt size constant as spaces grow.
  
5. **Bundle = delta. Understanding = delta + context.** Bundle boundaries carry zero semantic weight; episodes absorb all continuity.
  
6. **≥95% of events reach a container.** Orphans are monitored and alarmed. (V11 silently orphaned 85% via a watermark bug.)
  
7. **Every prompt has a verified production caller** (liveness check). Dead-but-tested subsystems are a defect class.
  
8. **Evals call the real model.** Frozen-response replay tests the parser, not the product.
  
9. **A wrong merge destroys; a wrong split is repairable.** Confidence <0.6 → unsorted over attach. Flag over act.
  
10. **Unknown beats wrong.** People, dates, amounts: emit unknown + a question, never a guess.
  
11. **No terminal states in the derived layer.** Spaces, tasks, claims, episodes all reopen; every state change is a new decision event; everything is undoable.
  
12. **Privacy is enforced at capture.** What never enters the log never leaks.
  
13. **Risky steps are code-gated, not prompt-gated.** The WhatsApp daemon refuses to send without a signed single-use approval token.
  
14. **Proactive means done, not offered.** For auto-risk actions: prepare it, show it, let the user discard — don't ask permission to help.
  
15. **Every run leaves a trace.** Prompt, context, output, cost — inspectable in the app.
  

* * *
## 3. System overview
```
  WhatsApp      Screen        Browser      SuperTwin      App UI
  (whatsmeow    (AX tree on   (history DB, Browser        (every user
   daemon,       screen        bookmarks)  (YT/X/IG/AI     interaction)
   send gated)   switch)                    accounts)
      |             |             |             |             |
      v             v             v             v             v
 ┌────────────────────────────────────────────────────────────────┐
 │ GATES (code): hash dedup · idle check · incognito drop ·       │
 │ password-window drop · min-content floor                       │
 └──────────────────────────────┬─────────────────────────────────┘
                                v
 ┌────────────────────────────────────────────────────────────────┐
 │ EVENT LOG (append-only SQLite) = source of truth = timeline    │
 └───────┬──────────────────────────────────┬─────────────────────┘
         |                                  |
         v                                  v
 ┌───────────────┐   ┌──────────────────────────────────────────┐
 │ ASSIST LANE   │   │ UNDERSTANDING LANE                       │
 │ (seconds)     │   │ dispatch windows (~5 min) + per-stream   │
 │ watch last    │   │ cursors + priority lanes                 │
 │ events + WM → │   │                                          │
 │ prepare       │   │  MAP: Orient per stream-bundle (parallel)│
 │ artifact →    │   │   └→ CRITIC gates every write → commit   │
 │ nudge         │   │  REDUCE: Decide per affected space       │
 │ (no durable   │   │   + Extract (claims) in parallel         │
 │  writes)      │   │  Digest pass for Cat-2 backfill          │
 └───────┬───────┘   └───────────────┬──────────────────────────┘
         |                           v
         |            ┌──────────────────────────────┐
         |            │ WORLD MODEL: spaces·chapters·│
         └── reads ──>│ tasks·claims·profile·CRM·    │<── CONSOLIDATION
                      │ entity graph                 │    T1 inline·T2 flag/
                      └───────┬──────────────────────┘    rolling·T3 deep
                              v
 ┌──────────────────┐   ┌────────────────────────────────────────┐
 │ EXECUTOR (agent) │──>│ UI: menu bar + liquid-glass window     │
 │ plan→act→verify→ │   │ Home·Timeline·Library·Settings         │
 │ replan; schedule │<──│ grounded bar · approvals · traces      │
 │ service (timers) │   └───────────────┬────────────────────────┘
 └──────────────────┘                   v
                        every interaction → EVENT LOG (the loop)
```

* * *
## 4. Capture
### 4.1 Two modes, one schema
1. **Backfill**: user picks a range (1d…5y, Everything). Resumable job, watermark advances only on confirmed source completion, periodic orphan scan re-queues anything unprocessed. Target ≥95% containment.
  
2. **Steady state**: continuous, forever. Every event carries `origin: live|backfill` and `age_band`.
  
### 4.2 Sources
1. **WhatsApp** — V11's Go whatsmeow daemon (NDJSON over stdio, pure-Go SQLite, mock mode for CI). Range enum extended to 5y/all (best-effort: history paging returns what the phone has). **New:** `send_message` **command that hard-refuses without a single-use approval token minted by the UI at tap-time.** The brain drafts; only the user's tap sends.
  
2. **Screen** — AX tree captured on every screen switch (app/window/tab), plus typing-pause, scroll-stop, and a ~60s fallback while a window stays active. Idle = zero capture. **Full-content capture**: the walk takes ALL text/value/label content in the tree (visible + scrolled-out where the app exposes it), not just visible chrome — this one capture is the single source for BOTH the understanding lane and the assist lane (§10.2 reads the same events from the log tail; there is no second, assist-only capture path). Distillation (pruning to salient elements) happens at read time per consumer, never at capture time — capture stores everything once. Tree-hash + content-hash dedup; store diffs (`new_chars`). **Enrichment by reference**: links/files/images seen in the tree are fetched directly and attached (governed by the Enrichment › Links toggle, §14.9 — page-text capture for browser visits, §4.2.3, is separate) — no screenshots in V1.
  
3. **Browser watcher** — local history DBs (Chrome/Safari/Arc): URL, title, visit time, count, transition, referrer. Bookmarks file watched. **Page content is part of the record, same standard as AX**: (a) when the browser is frontmost, full page text comes from the AX capture (linked by ts+URL, never duplicated); (b) visits with no AX coverage (background tabs, fast switches) and every bookmark are fetched by reference — reader-mode text extraction via the SuperTwin Browser, Cat-1 domains only, dedup by URL+content-hash. One page, one stored text, however it arrived.
  
4. **App UI** — every interaction is an event: open, dwell, expand, edit, dismiss, snooze, drag, search, chat, approval.
  
5. **Expansion sources** — via SuperTwin Browser + exports + free APIs (§13).
  
### 4.3 Privacy at capture
1. Incognito/private windows: never captured (window attributes) — and history DBs never contain them.
  
2. Password manager windows blocklisted: their pixels/AX text never enter the log. (Unrelated to login reuse — sessions for the SuperTwin Browser come from logins made in it, §12.)
  
3. Per-app/per-stream capture pause and honest delete (cascades) in Library.
  
### 4.4 Enrichment (lane E, from V11)
1. Images → captions (batched CLI calls, id echo-back, split on mismatch). Audio → local whisper (zero tokens). Links → scraped text. YouTube → captions.
  
2. Never blocks understanding: placeholders first; when a bundle's pending count hits zero, exactly one re-understand job runs, scoped to the affected episodes, through the same idempotent write path. If the placeholder forced unsorted, the bundle re-dispatches fully.
  
### 4.5 Content economy (what models actually see)
Full AX trees and page texts are stored once but would drown every prompt. Rule: **store everything, send digests, expand on demand.**

1. **Digest line at ingest**: every content-heavy event (AX capture, page text) gets a one-line structured digest, computed by code + a cached haiku-class call: `{title, app/domain, doc_type (article|listing|form|chat|code|dashboard…), key_entities, gist ≤25 words, token_count, content_ref}`. Cost is paid once per unique content-hash, then cached forever.
  
2. **Three fidelity levels, chosen by the reader**: L0 digest line (~30 tokens) · L1 distilled content (salient elements/sections, ~10–20% of full) · L2 full text. Defaults: retrieval results and context slices → L0; the events a pass is directly processing → L1; L2 only when a pass or the executor explicitly requests it via `content_ref` (rare, logged).
  
3. **Applies uniformly**: understanding packer (§6.4), assist watcher (§10.2 — its screen/browser/chat tail arrives as L1 for the current context, L0 for everything adjacent), grounded bar retrieval, executor context. Distillation is read-time and consumer-specific; capture stays full-fidelity.
  
4. Token accounting per level in the run ledger — the L1/L2 escalation rate is a watched metric (rising = digests too lossy; fix the digest prompt, not the budget).
  

* * *
## 5. Priority, categories, age bands
### 5.1 Category identification (code-first)
| Source | Cat 1 | Cat 2 | How decided |
| --- | --- | --- | --- |
| Chats | DMs; groups user EVER replied in; transactional business (OTP/receipts/bookings) | never-replied groups; promotional | user-reply = pure code; business split = cached one-time tier call |
| Browser | typed/bookmarked/repeat visits, real dwell | ad/tracker domains (blocklist), one-touch redirects, ~0 dwell | per-domain heuristics + cached cheap call for ambiguous |
| Screen | everything the user actively does | — (passive media just low-signal) | by definition |
| Mail (future) | replied-to senders | List-Unsubscribe/bulk headers | deterministic |

Safety: Cat 2 is later + coarser, never dropped. Any engagement (reply, click, save) **instantly promotes** the stream to Cat 1 with retroactive full processing. Misclassification costs latency, never data.
### 5.2 Processing order
1. **Live preempts everything, always.**
  
2. Backfill: **day-major, newest day first**; within a day, source order (WhatsApp → Screen → Browser → …); within a source, Cat 1 streams ordered by **engagement score** (user-reply frequency, recency-weighted — an ordering signal only, never relationship value).
  
3. Cat 1 data + Cat 1 media enrichment run in parallel on all CLI slots. **Only when all Cat 1 is done** → Cat 2 data (Digest pass) → Cat 2 media enrichment last (mostly lazy/on-demand). Whisper is local and exempt.
  
4. First-experience slice: most recent 3–7 days of top-engagement chats first → first proposals on screen in ~2–3 minutes, streaming in as ticks commit.
  
### 5.3 Age bands (backfill policy, hard constraint in prompts)
| Band | Age | Extracted | Never |
| --- | --- | --- | --- |
| A   | 0–30d | everything | —   |
| B   | 1–6mo | spaces, claims, recurrences; tasks only with verified still-open evidence | stale-task spam |
| C   | 6mo–2y | claims, CRM, recurrences (renewals, birthdays), life events | live tasks (recurrence templates only) |
| D   | 2y+ | coarse claims, relationships, narrative — Digest pass at chat-month granularity | tasks, spaces (unless clearly alive) |

Recurrence detector runs across all bands: a band-C insurance renewal becomes next month's task.
### 5.4 Freshness UX
- Headline per source: **"Knows you: Mar 2024 → 2 min ago"** — the _understood_ range; the left edge crawls backward during backfill.
  
- Expand for detail: "capturing live ✓ · importing history: at Jan 2024 (72%) · understanding: caught up". A visible lag chip ("catching up — 14 min behind") appears only when the 10-min promise is breached.
  

* * *
## 6. Event log, bundles, dispatch
### 6.1 Event envelope
```
event { id ulid · ts · captured_at · source · kind · origin live|backfill ·
        age_band · stream_key · actor · roles {sender, audience[], receiver[],
        mentions[]} · payload (typed per kind) · content_hash · blob_refs[] }
```

Example (WhatsApp):

```json
{ "id":"01J9Q…","ts":"2026-08-25T19:42:10+05:30","source":"wa",
  "kind":"wa.message","origin":"live","age_band":"A",
  "stream_key":"9198xx-1602@g.us","actor":"contact:rohan",
  "roles":{"sender":"contact:rohan","audience":["self","rohan","tanvi","karan"],
           "receiver":["*audience"],"mentions":[]},
  "payload":{"text":"guys lets lock goa 18-21 dec, flights are cheap rn"},
  "content_hash":"9f2c…","blob_refs":[] }
```
### 6.2 Delta bundles + dispatch (there is no "segmenter")
1. Per-stream **cursor**. Every dispatch window (~5 min live), each stream with new events yields one delta bundle = events between cursor and now. ~30 lines of code, no close policies, no boundary heuristics.
  
2. **Low-signal deferral**: trivial non-urgent bundles (no entities, no intent verbs, tiny chars) carry forward and accumulate; max-defer ~30–60 min, then they process anyway (an "ok" still matters for closure).
  
3. **Max-size cap**: huge backfill bundles split; successor carries predecessor context.
  
4. **Urgency**: handled by the assist lane (§10), which watches events in seconds — not by dispatch exceptions.
  
5. Bundle boundaries are semantically meaningless by design; episodes + thread history absorb every mid-conversation cut.
  
### 6.3 Tick anatomy — map-reduce
```
 window fires
   │  bundles: [wa:goa-gang] [wa:ma-dm] [scr:chrome¦goibibo] [br:chain-8842]
   v
 MAP    ── Orient(goa-gang) ─┐  each: own call, own context,
        ── Orient(ma-dm) ────┤  parallel, writes nothing
        ── Orient(goibibo) ──┤
        ── Orient(chain) ────┘
   v
 GATE   ── Critic grades all proposed writes → commit via single writer
   v
 REDUCE ── group committed episodes BY SPACE →
        ── Decide(sp_goa_dec)   ── Decide(sp_family)     (parallel across
        ── Extract(claims, per affected people)           spaces, serial
   v                                                      per space)
 write tasks·chapters·plans·closures·schedules → queues → UI
```

1. Relatedness is never guessed upfront: streams never share a prompt; affinity is the observed fact that episodes landed in the same space.
  
2. Decide work queue: `(space_id, pending_episode_ids, priority)`, max one queued entry per space (new episodes merge in), worker pool bounded by CLI slots, priority urgent > live > backfill.
  
3. CLI discipline (V11, verified): prompt on stdin, stream-json, bare-call contract (no tools, max-turns 1, empty settings, tmp cwd), one repair round, then quarantine — model output is never silently discarded.
  
4. Models: every step **defaults to Haiku** (§14.9); recommended classes are Orient/Extract/Decide sonnet-class, Critic/Digest/Assist-eval haiku-class — shown next to each picker, applied only by user choice, eval-gated. Per-role model selection in Settings (V11's system, kept).
  
### 6.4 Context assembly (the anti-starvation packer)
Every Orient call gets:

1. The delta bundle (enriched).
  
2. **Thread history**: last ~20–40 events of the SAME stream from the log, regardless of bundle/processing boundaries; elastic — extends to cover the open episode's last exchange; quoted/replied messages always fetched explicitly.
  
3. Open + recently-dormant episodes of this stream **∪ dormant episodes surfaced by retrieval relevance** (id, summary, last-active, space links).
  
4. Candidate spaces from **retrieval** (four lanes: FTS · embeddings with retrieve-then-judge · entity overlap · bridge exact-match; recency boost): label, goal, life area, 2–3 exemplar episode summaries.
  
5. **Recent-context block**: spaces active in the last few hours, as weak candidates even with no content match (a hint the model may weigh — never a join rule). This is what links "database browsing" to "side project" when words don't overlap.
  
6. Roster + roles + stream tier + engagement stats + party context.
  
7. Related cross-source episodes via bridges/entities.
  
8. Age-band + mode policy.
  

* * *
## 7. People: roles, entities, circles
### 7.1 The role model (per message)
sender · audience · receiver (⊆ audience; = audience when unaddressed) · mentioned receiver (in audience) · mentioned third party (not in audience). DMs: receiver = audience = one person. Email carries all five from headers.
### 7.2 Resolution ladder
1. **Structural (code, conf 1.0)**: sender, audience (membership / to+cc), **@mentions** (platform-resolved), reply/quote chains.
  
2. **Roster** (packer): resolved identities + relationships + nickname notes, injected into every prompt.
  
3. **Roster + retrieval**: unknown names ("Aarav") pull candidate identities from the entity store (name, phone, co-mention history) into the prompt.
  
4. **Model**: plain-name mentions, pronouns (coreference over roster + thread history, with confidence), receiver inference in groups (helped by ±context; revisable when later evidence confirms — decisions are living).
  
5. **Code again**: mentioned-receiver vs third-party = set membership test against the structural audience. Never the model's job.
  
6. Unknown beats wrong, always: low confidence → `unknown` + question.
  
### 7.3 Entities, provisional people, circles
1. Any resolved-enough mention creates a **provisional person** — name + context anchors, zero identifiers needed (kids, cousins, "Priya's landlord"). Merges forward via retrieve-then-judge when identifiers or confirmations arrive. User can merge/split in People.
  
2. **Circles** in the CRM: partner · family · close friends · friends · coworkers · important services · old batchmates · acquaintances · businesses. Inferred from content, tone, claims, metadata — reply volume is one weak signal (the family group with few replies still outranks a chatty acquaintance group). User-editable. Circles drive: processing boosts, drafting tone, nudge thresholds, task-applicability, brief inclusion.
  
3. **Address-style memory**: per user-per-group address terms classified **discriminating** (stable unique mapping → addressee evidence) vs **generic** ("bro/boss/maalik/dost" used for many → ZERO addressee evidence, never a relationship claim — but still stored as **tone/voice profile** per person/group for drafting: register, language mix, emoji habits).
  
4. Task creator/assignee and claim subjects consume resolved roles — never re-derive people.
  
5. Applicability judgment: broadcast "everyone must…" in a 200-member never-replied group is almost never your task; the same words in your 5-person project group are. Engagement stats + tier + circle ride in the prompt for exactly this.
  
### 7.4 Time resolution (two layers)
1. Extraction: relative expressions resolve against the **message timestamp**, stored absolute + timezone, original phrase kept for audit.
  
2. View: UI renders relative to now ("tomorrow", "3 days overdue"), computed at render. Backfilled past-dates are closure-checked, never surfaced as due.
  

* * *
## 8. The five passes — prompts
Conventions: strict JSON out; every write carries evidence + confidence; conf <0.6 attach → unsorted; every decision stored (inputs, output, justification, confidence, model, prompt version) and shown under "why?"; shared byte-identical preamble per pass for prompt caching; one repair round → quarantine. **Model classes in the headings below are recommendations, not defaults**: every step ships defaulted to Haiku; the recommendation appears next to each picker in Settings › Intelligence (§14.9) and upgrading is eval-gated.
### 8.1 ORIENT (per stream-bundle, sonnet-class)
System (core):

```
You are SuperTwin's Orient pass. Turn one stream's new events into
episodes and file each into spaces.
- Episode = one temporal burst of activity about one thing IN THIS
  STREAM. Join the open/dormant episode when this continues it; new
  episode for a new burst; split by MESSAGE RANGES only when the delta
  clearly covers unrelated topics. Same topic after a long break = new
  episode chained to the old.
- Filing order per episode: (a) MATCH a candidate space (attach;
  conf <0.6 → don't); (b) PROPOSE a new space only on real goal
  evidence — intent, commitment, money, dates, or repetition across
  ≥2 bundles/sources; label 4–8 specific words; (c) UNSORTED otherwise
  — a good answer.
- Never one space per chat. Never split one conversation topic across
  new spaces. A wrong merge destroys; a wrong split is repairable.
- Resolve people to roster ids; unknown beats wrong; emit questions.
- Age-band policy and mode (propose-only) are hard constraints.
- Recent-context spaces are hints, not rules — attach only with a
  stated reason.
JSON schema only.
```

User (packed):

```
[BAND] A live   [MODE] propose-only
[ROSTER] self=Aditya · rohan=Rohan Mehta · tanvi=Tanvi S · k1=Karan
[STREAM] wa group "Goa gang" · tier personal-group · engagement: high
[THREAD HISTORY] …22 msgs…
[EPISODES here] ep_412 "villa shortlist" active 3h ago → sp_goa_dec
[CANDIDATE SPACES] 1. sp_goa_dec "Goa trip with Rohan in December" ·
  Travel · goal: 18–21 Dec trip · exemplars: "dates locked", "flight
  compare"  2. sp_diwali "Diwali gifts for family" · open ep_881
[RECENT CONTEXT] sp_sideproject (active 40 min ago)
[CROSS-SOURCE] browser chain 8842: goibibo Goa 18–21 Dec (bridge)
[NEW BUNDLE] e1 19:42 rohan: guys lets lock goa 18-21 dec …(13 events)
```

Output (example):

```json
{"episodes":[
  {"action":"join","episode":"ep_412","events":["e1","e4-e11"],
   "summary":"Dates 18-21 Dec agreed; Rohan to share flight link.",
   "evidence":[{"event_ids":["e1"],"quote":"lets lock goa 18-21 dec"}],
   "confidence":0.93},
  {"action":"join","episode":"ep_881","events":["e2","e3"],
   "summary":"Tanvi asked re Diwali pool; Aditya to pay tonight.",
   "evidence":[{"event_ids":["e2"],"quote":"did anyone pay the diwali pool??"}],
   "confidence":0.9}],
 "proposals":[],"unsorted":[],"questions":[]}
```
### 8.2 CRITIC (per tick, haiku-class)
System (core):

```
You grade another pass's writes BEFORE commit. Adversarial,
precision-biased. You verdict; you never rewrite.
Check: evidence actually supports the action · duplicate space/task
vs retrieved near-matches · contamination (unrelated content into a
space) · confidence honesty · label specificity (4–8 words).
Verdicts: commit | reject(reason) | downgrade_to_unsorted |
flag_overlap(space_id) — flags don't block; they queue a Tier-2
review immediately. Quotes must be verbatim from cited events —
fabrication is auto-reject. JSON only.
```

Input: Orient's decisions + retrieved near-duplicates + rubric. Why separate: a model grading its own output inherits its own errors; Orient is recall-biased, Critic precision-biased, fresh context. One cheap call; removable if evals ever show zero lift.
### 8.3 EXTRACT (per affected people, sonnet-class)
System (core):

```
Extract claims about people from committed episodes.
Kinds: fact, preference, belief, opinion, interest, habit,
recommendation, workflow, relationship.
- Subject = resolved roster id or "unknown"+hint. UNKNOWN BEATS WRONG.
- Resolved third person, never aliases. Every claim: evidence quote,
  confidence, valid_from.
- Against existing claims emit: new | reinforces(id) | contradicts(id)
  — contradictions never overwrite; a judge resolves supersede vs
  coexist; old claims get validity ends, never deletion.
- Habits/preferences need repetition or explicit statement — one
  purchase is not a preference; an ad is NEVER a preference
  (tier policy). Jokes/sarcasm are tone, not beliefs.
- Mentions of non-roster people → provisional person records.
- Also maintain tone profiles: how the user addresses each
  person/group (register, language mix, emoji) — generic address
  terms ("bro","boss") feed tone, never identity or relationship.
JSON only.
```
### 8.4 DECIDE (per space, sonnet-class)
System (core):

```
You run for ONE space with its full state and its new committed
episodes (all sources, time-ordered). Produce:
1. CHAPTERS: group this space's episodes into cross-stream sub-goal
   chapters ("Flights","Stay"). Create sparingly; single-shot spaces
   need none. Chapters with dates are the milestones.
2. TASKS: explicit / implicit (entailed) / suggested (from plan gaps;
   ≤2/day/space; clearly marked). Fields: title, type, category
   (communication|transaction|research|scheduling|filing|creation|
   monitoring|errand), risk class (auto|approve-final|approve-first|
   advise-only — conservative: anything moving money or messaging
   people is never auto), owner (resolved; others' tasks are not the
   user's — at most a monitoring item), due (absolute), evidence.
3. SCHEDULES: emit schedule candidates when time windows are computable
   (check-in opens T-48h; ticket window 10am → poll 09:55; traffic
   check with lead time). mode=auto ONLY if action is auto-class AND
   intent is high-confidence AND value is time-bound; else confirm.
4. CLOSURES: two-sided/hard evidence → close (≥0.85). One-sided intent
   → suggest_close only. Similar-but-different ≠ close. Cancellation
   closes as cancelled, never done. False close = data loss.
5. FOLLOW-UPS: when a task just closed (by us or by the user), propose
   the 1–2 most helpful next tasks from the plan ("because: flights
   booked ✓"). Same auto/confirm policy.
6. PLAN: update goal → chapters → next actions when materially changed.
Age-band policy is hard. JSON only.
```

Output (example, abridged):

```json
{"space":"sp_goa_dec",
 "chapters":[{"id":"ch_flights","label":"Flights","status":"active",
   "episodes":["ep_412","ep_browser_88"],"target":"2026-08-29"}],
 "tasks":[{"title":"Book flights CCU-GOI 18 Dec, return 21 Dec",
   "type":"explicit","category":"transaction","risk_class":"approve-final",
   "owner":"self","chapter":"ch_flights","due":"2026-08-29",
   "evidence":[{"event_ids":["e1"],"quote":"lets lock goa 18-21 dec"}],
   "confidence":0.9}],
 "schedules":[{"task":"web check-in","fire_at":"2026-12-16T07:00+05:30",
   "mode":"auto","reason":"opens T-48h; time-bound; check is auto-class"}],
 "closures":[{"task":"tsk_pool","verdict":"suggest_close",
   "reason":"one-sided: 'paying tonight'","confidence":0.55}],
 "followups":[],"plan":{"next":["flights (awaiting approval)","villa shortlist"]}}
```
### 8.5 DIGEST (Cat-2 backfill, haiku-class)
```
One stream, one month of history. Output ONLY: a 3–5 sentence stream
summary · claims about roster/known people (evidence-quoted) ·
recurrence candidates (billing cycles, annual events). No episodes,
no tasks, no spaces. JSON only.
```

* * *
## 9. Spaces, chapters, unsorted
```
Life area
  └─ Space (goal; label 4–8 specific words; types: active|dormant,
     short|long-term, permanent|ephemeral, one-time|recurring,
     private (V1), solo (V1))
       └─ Chapter (cross-stream sub-goal; dated chapters = milestones)
            └─ Task (schedule optional)
       Episodes = evidence layer beneath (stream-scoped), attached to
       space + optionally chapter. Claims live globally; spaces hold refs.
```

1. **Propose-only mode** for the first months: the twin proposes spaces, you approve. Graduation to auto-create after 2+ clean weeks on the gates. User-created spaces (grounded bar) skip proposal — they're active instantly.
  
2. **Space birth sweep**: retrieval over unsorted + log pulls related past episodes in (including the message that justified creation). Unsorted unclaimed 30 days → archived, still searchable, still sweepable.
  
3. Cross-source association lives here: episodes from chat, browser, screen meet in the space (via bridges → strongest, retrieval attach, entity graph, recent-context hints); chapters make it visible.
  
4. Enrichment tasks (auto-class research: "pull current CCU-GOI prices") populate spaces with web data as cards.
  
5. Second-look queue re-verifies 0.60–0.75 attaches at the next consolidation window.
  

* * *
## 10. Assist lane (proactive help, seconds)
1. **Trigger gate (code, pre-LLM — no daily cap)**: there is no fixed nudge quota. An assist pass initiates only when BOTH hold:
  

- **Novelty (code-enforced event-count threshold, cross-source)**: a per-topic novelty accumulator counts **distinct, deduplicated events about the same thing** — AX-capture events (content-hash-new only), browser visits, WhatsApp messages — joined into one topic by the same machinery understanding uses: bridges (URL/phone/order-id), entity matches, active episode/space, recency. The gate fires only when the accumulator crosses `N` distinct events (default 5, per-category defaults — e.g. 3 for transaction contexts, 7 for research — user-editable in Settings › Assist, §14.9) **of which ≥2 are new content** (not re-observations). Repeated identical data — same page re-captured, same message re-read, idle dwell — increments nothing. Cross-source counts double-weight: a WhatsApp message + a browser visit about the same thing is stronger evidence of a live goal than 2 events from one source.
  
- **Intent confidence**: the watcher (below) must return high confidence on WHAT the user is trying to do (a goal it can name, ideally mapped to a known space/task). Low-confidence intent → log, don't nudge. Plus code-enforced hygiene: per-context cooldown after any nudge, suppression after 2 dismissals in a context, quiet hours. Rate emerges from behavior — a heavy planning day may earn 8 nudges, a quiet day zero.
  

2. **Watcher input = the event log tail, not a separate capture**: assist has NO capture path of its own. It reads the same events every lane reads:
  

- the last few **AX-capture events** (full-content trees captured on app/window/tab switch, typing-pause, scroll-stop — §4.2; assist gets the same diffs understanding gets, just seconds-fresh),
  
- **recent browser events** (history visits, bookmark adds) for the active tab chain,
  
- the active **chat stream's last messages** (WhatsApp etc.),
  
- retrieval-picked world-model slices (active spaces, open tasks, claims) + suppression state.
  

A haiku-class evaluation over this outputs `{inferred intent, intent_confidence, helpfulness score, proposed auto-class action | nothing}`. Below either threshold → nothing (fractions of a cent). One capture, two readers — if assist ever needs data the log doesn't have, the fix is better capture, never a side channel.

3. **Do, don't ask**: above threshold it spawns an executor-lite (bounded tool loop: browser, drafts, world-model reads) and prepares the most helpful next step — sometimes a cross-site options view, sometimes a draft, sometimes a cart. Think 3–4 steps ahead; prepare what the user would do next. Auto-class only; never payment/send.
  
4. **Nudge anatomy**: `intent` ("Saw you comparing Anjuna villas — Goa trip › Stay") + `what I did` ("compared 6 across 3 sites; 3 fit budget") + artifact + actions + space/chapter chip. The twin always shows its reasoning.
  
5. **Artifacts are durable**: popup is ephemeral; the artifact collapses to a one-liner in the menu-bar "Prepared" list and lives in the in-app **"Prepared for you" shelf** + Timeline. Statuses: new / seen / dismissed / graduated / expired (moment-bound items auto-archive past their window). Re-opening restarts positive signal.
  
6. **Reconcile signals** (graded, not binary): edited/iterated/used-in-followup > opened+dwelled > glanced; dismissed/ignored-N-times → politeness throttle + per-context suppression; explicit "don't do this" = strongest. Graduation turns an artifact into a durable task/space with provenance — through the normal gate.
  
7. **One brain, two service levels**: assist reads the freshest world model + raw seconds; it never writes durable memory ungated. As the understanding lane gets fast (~30–60s small deltas), assist increasingly just reads fresh memory — the lanes converge in feel; the write-gate separation is permanent memory hygiene.
  

Assist evaluator prompt (haiku-class, core):

```
You watch the user's last seconds of activity and decide whether
SuperTwin can help RIGHT NOW by doing something safe in advance.
- Infer what the user is trying to do. Use their world model
  (active spaces, open tasks, claims) — help should be personal,
  not generic.
- Propose at most ONE preparation: the step the user would do next,
  3–4 steps ahead when possible (a cross-site comparison, a draft,
  a prepared booking up to payment). auto-risk-class actions only —
  NEVER pay, send, book, or change accounts.
- Respect the suppression state: suppressed contexts and active
  cooldowns mean answer "nothing". "Nothing" is the correct answer
  most of the time.
- Report intent_confidence honestly: only nudge-worthy when you can
  name the user's goal specifically, ideally tied to a known space
  or task. Generic guesses ("browsing travel sites") are low.
Output JSON: {intent, intent_confidence_0_1, helpfulness_0_1,
action|null, artifact_type, space_hint, reasoning}.
```

User (packed): last few AX-capture events (same events the understanding lane ingests) + recent browser visits/bookmarks for the active tab chain + active chat stream's last messages + retrieved world-model slices + suppression/cooldown state.

* * *
## 11. Tasks, scheduling, execution
### 11.1 Task object
```
task { id · space · chapter? · title · type explicit|implicit|suggested ·
  category communication|transaction|research|scheduling|filing|creation|
           monitoring|errand ·
  risk_class auto|approve-final|approve-first|advise-only ·
  owner · due · status open|scheduled|executing|needs_input|
  needs_approval|done|cancelled|dismissed (all reopenable) ·
  schedule? { fire_at|recurrence · mode auto|confirm ·
              source inferred|user · polling {interval,until,max} } ·
  evidence[] · plan_ref · result_ref · decisions[] }
```
### 11.2 Scheduled / routine tasks
1. Sources of schedules: Decide (computable windows: check-in T-48h, ticket window opens 10am → poll 09:55 until open, traffic check with lead time), executor wrap-ups, explicit user asks, observed patterns (briefs).
  
2. **auto** (schedule + execute + announce "Scheduled: web check-in Wed 7:00am — tap to change") only when ALL: action is auto-class AND high-confidence intent AND time-bound value (missing the window kills the value). Everything else — and every recurring commitment (AI news brief, 8am daily commitments brief) — is **confirm**: a suggestion card with editable time.
  
3. Deterministic timer service fires schedules → enqueues executor tasks with space context; polling patterns capped. Results → nudges/Today. Risky steps still stop at approval.
  
4. Brief times learn from when you actually read them; changes only ever suggested.
  
### 11.3 Follow-up tasks
Next-step pass triggers on (a) executor completion, (b) closure detection seeing YOU completed something. Input: space plan + chapter state + what closed. Output: 1–2 most helpful next tasks with visible provenance ("because: flights booked ✓"). Same auto/confirm policy; subject to the same per-context cooldown/suppression rules as nudges (§10.1) — no fixed caps.
### 11.4 Executor (the agentic loop)
```
 plan → acceptance criteria → [ gather context → act → verify ]─┐
   ^                            (world model, web,     not met? │ met?
   │   blocked? → replan a       ask user if truly   ← loop     │
   │   different route, using    missing)                       v
   │   the attempt log — never                        risky step remains?
   │   fail the same way twice;                        no → done
   └── bounded attempts/budget,                        yes → approval card
       then best-partial + gaps                              (only now)
```

1. Criteria first; verify every cycle; attempt log feeds every replan; multiple plans allowed; budget exhaustion → best partial + what's missing + next idea, never silent death.
  
2. Missing info → one precise question, pause at needs_input. Never guess.
  
3. **Risky step is terminal and double-gated**: exists only after acceptance is met; executes only on approval; enforcement is code (approval tokens), not prompt.
  
4. Results emit typed schemas (comparison_table, itinerary, draft_preview, approval_card, research_brief, checklist, receipt) → generative UI (§14.5).
  
5. Completion: executor self-close · evidence closure by Decide (two-sided ≥0.85 auto; one-sided → "looks done — confirm?") · user mark-done (always learned from).
  

Executor system prompt (core):

```
Execute ONE task. Tools: browser, world-model read, drafts, files.
1. Plan + explicit acceptance criteria first.
2. Execute stepwise; gather context before acting; if required info is
   missing and unfindable, emit one precise question and pause.
3. Verify each cycle against criteria; log every attempt; never repeat
   a failed approach unchanged; replan freely within budget.
4. NEVER perform payments, sends, bookings, irreversible actions.
   When criteria are met and such a step remains, emit an approval
   request stating exactly what will happen.
5. Emit the final result in your category's result schema.
Budget: N cycles / $X → best partial + gaps.
```

* * *
## 12. SuperTwin Browser
One Chromium, one profile, three jobs: user browsing + in-app webviews, agent execution, and capture of API-less sources.

1. **Engine**: bundled Chromium, headed-but-hidden (never `--headless` — the #1 bot signal), launched by the worker with a persistent dedicated profile, driven over CDP pipe.
  
2. **One profile serves everything**: in-app webview cards, user browsing, and agent runs are tabs of the same profile presented inside the app shell (parented window; CDP screencast only for the watch-the-agent replay view). Log in once, logged in everywhere; a topic started in the app continues in the same browser. WKWebView survives only for loginless static rendering (link previews, reader).
  
3. **Sessions**: born in the browser that uses them — "Connect your accounts" onboarding with visible one-time logins. Chromium's built-in "Import from Chrome" brings passwords + bookmarks (a user-driven browser feature; our code never touches encrypted stores), so each first login is one click. No cookie-file decryption, ever.
  
4. **The hands**: ~1k-line CDP harness in the worker exposed to Claude Code as MCP tools. **The eyes**: distilled AX tree with stable element ids (Agent-E pattern, MIT); Set-of-Marks screenshots as fallback. **The memory**: per-site domain skills the agent writes once and reuses; captured-network replay (Libretto pattern) — learn a site's own JSON endpoints once, then poll them in-page with the site's own cookies; SQLite mirrors with incremental cursors and adaptive rate limits.
  
5. **Contract**: agent tabs never touch user tabs; every agent session is replayable (trace); visible kill-switch.
  
6. **Ban-risk posture (code-enforced)**: real profile + real fingerprint + home IP; human-hours jitter (±30 min, random skips); low frequency; read-only for capture; incremental stop-at-last-seen; adaptive backoff on 429; hard-stop + notify on any challenge/checkpoint page; never automate login/2FA.
  
7. Study BrowserOS/Skyvern approaches freely; ship none of their AGPL code. Reused MIT patterns: browser-harness (thin CDP + domain skills), Agent-E (distillation), Libretto (network capture), cli-printing-press (sync-mirror shape).
  

* * *
## 13. Source expansion (free routes only)
| Source · data | Backfill | Steady state | Risk |
|---|---|---|---|
| YT watch history | Google Takeout (`watch-history.json`; native re-export every 2 months) | Data Portability API daily where region-supported; else agent browser reads `/feed/history` 1–2x/day | none/low |
| YT playlists+likes | Data API v3 (free OAuth) | same API | none |
| X own posts+likes | official archive export | agent-browser profile diff daily | low |
| X bookmarks | agent-browser full scroll capturing the page's own GraphQL responses (beats API's 800 cap, gets folders) | daily diff, stop-at-last-seen | low |
| IG everything incl. saved | "Export your information" JSON (only source with saves) — deep-linked, Downloads-watched, monthly | gentle in-session `/saved/` read ≤1x/day, opt-in with risk disclosure | low–mod |
| ChatGPT | official export (`conversations.json`, tree — walk the mapping) | own-session `/backend-api/conversations` incremental read 1–2x/day (lowest-enforcement service); memories = manual snapshot | low |
| Claude | claude.ai official export (manual cadence) | **`~/.claude/projects/*.jsonl` file-watch — plain JSONL on disk, zero risk, realtime.** NEVER session-scrape claude.ai (active 2026 harness bans, ToS §3.7) | none (files) |
| Gemini | Takeout → My Activity → **"Gemini Apps"**, JSON (the top-level "Gemini" entry exports Gems only — trap). Native 2-month schedule | same; no API exists (Data Portability has no Gemini group) | none |

Hard rules: no paid APIs; **never** instagrapi/instaloader/twscrape/twikit-class private-API libraries on real accounts; official exports + free APIs first; agent browser fills only the gaps at human cadence in the user's own session. Rollout by risk: Claude Code files (day one) → YouTube → X → ChatGPT → Gemini → Instagram last, after challenge-detection is proven on X. Every source is just an adapter into the same event log — zero new architecture.

* * *
## 14. UI / UX
### 14.1 Shape
1. **Menu bar app** — always resident. States: `◉ idle · ◔ processing · ● needs you (n) · ⏸ capture paused`. Click → compact panel: Approvals → Questions → **Prepared** (one shelf for BOTH assist-lane nudge artifacts AND executor results — everything the twin finished lands here as a one-liner, reopenable; the latest unseen nudge shows as a highlighted top line). No daily nudge quota — frequency is governed by the assist trigger gate (§10.1).
  
2. **Main window** — double-tap right-⌘ (configurable). Translucent liquid glass. Esc dismisses.
  
3. **Navigation** — floating pill navbar, top-center, sticky: `Home · Timeline · Library · Settings` (⌘1–4).
  
4. **Modals for depth** — click anything → details, evidence quotes, "why?" (decision record: justification, confidence, source events, trace link), history, actions.
  
5. **Grounded bar** — floating bottom-center: search / grounded chat (citations to events) / actions ("plan goa trip…", "remind me…"). History icon (⌘↑) reopens past threads. Answers can embed webview cards rendered by the SuperTwin Browser.
  
### 14.2 Home
```
┌───────────────────────── liquid glass ──────────────────────────────┐
│            ⌂ Home    ◷ Timeline    ▤ Library    ⚙ Settings          │
│                                                                     │
│ ┌─ Today ───────────────────────┐ ┌─ Spaces ──────────────────────┐ │
│ │ ▸ Approve: flights CCU-GOI ₹18k│ │ ● Goa trip with Rohan · Dec   │ │
│ │ ▸ Pay Diwali pool (due today) │ │   Flights ✓ · Stay ◐ · 3 tasks│ │
│ │ ▸ Q: cab from home or office? │ │ ● Diwali gifts for family     │ │
│ │   ⋯ 4 more                    │ │ ○ Gym restart (dormant)       │ │
│ └───────────────────────────────┘ └───────────────────────────────┘ │
│ ┌─ Prepared for you ────────────┐ ┌─ Review queue ────────────────┐ │
│ │ ◆ Villa comparison — 3 fit    │ │ ? New space: "Hampi trek Oct" │ │
│ │   budget (Goa › Stay)         │ │ ? Merge: "Goa food" → Goa trip│ │
│ │ ◇ Draft reply to Sameer       │ └───────────────────────────────┘ │
│ └───────────────────────────────┘ ┌─ Recent understanding ────────┐ │
│ ┌─ People ──────────────────────┐ │ + Rohan prefers aisle seats   │ │
│ │ Ma · birthday in 12 days      │ │ + Trip budget ₹6k/night   ··· │ │
│ └───────────────────────────────┘ └───────────────────────────────┘ │
│           ┌─────────────────────────────────────────────┐           │
│           │ ⌕  Ask, search, or tell me to do something  │           │
│           └─────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────────────┘
```

Sections scroll internally or expand; no global feed. Freshness chip per §5.4 lives in the header area when relevant.
### 14.3 Timeline & Library
1. **Timeline** = the event log rendered: unified, newest-first, day scrubber; filters source/person/space; every row shows filing chips; click → modal.
  

```
┌───────────────────────── liquid glass ──────────────────────────────┐
│            ⌂ Home    ◷ Timeline    ▤ Library    ⚙ Settings          │
│                                                                     │
│  [ all sources ▾ ] [ person ▾ ] [ space ▾ ]              ⌕ search   │
│  ◂ Aug ─────────────────────●───────────────────▸   day scrubber    │
│                                                                     │
│  TODAY                                                              │
│  14:02 ⬡ screen   Airbnb — Anjuna villas · 4 min    → Goa › Stay    │
│  13:58 ⬡ browser  airbnb.com/rooms/… ×3 (chain)     → Goa › Stay    │
│  13:41 ⬡ WhatsApp Goa gang · 12 msgs ❝pool villa❞   → Goa › Stay    │
│  11:20 ◆ twin     prepared: draft reply to Sameer   → Work          │
│  09:15 ⬡ WhatsApp Ma ❝ticket book kar diya?❞        → unsorted ⚑    │
│  YESTERDAY                                                          │
│  18:40 ⬡ screen   Figma — v13 mocks · 40 min        → Work › v13    │
│  ⋯                                                                  │
└─────────────────────────────────────────────────────────────────────┘
```

Rows group micro-events (a 12-message burst, a visit chain) into one line; expand inline or click → modal. The `→ space` filing chip is draggable (correction, §14.4). Twin actions (◆) appear as first-class rows — the twin's history is on the same timeline as yours.

2. **Library**: per-source view of what's captured + per-source trust controls. Three sources pre-P5: Chats, Browser, Screen; expansion sources add tabs as they ship (each with capture status + connect flow).
  

```
┌───────────────────────── liquid glass ──────────────────────────────┐
│            ⌂ Home    ◷ Timeline    ▤ Library    ⚙ Settings          │
│                                                                     │
│   [ Chats ]   [ Browser ]   [ Screen ]        + connect a source    │
│                                                                     │
│ ─ Chats ────────────────────────────────────────────────────────    │
│  Goa gang       Cat-1 · knows you: Jan 2024 →   12 msgs today  ⏸    │
│  Rohan Mehta    Cat-1 · knows you: 2019 →       2h ago         ⏸    │
│  PTA updates    Cat-2 · never replied           (reply promotes)    │
│                                                                     │
│ ─ Browser ──────────────────────────────────────────────────────    │
│  today   airbnb ×7 · makemytrip ×3 · github ×12    (visit chains)   │
│  chain   ⌕"anjuna villas" → airbnb → 3 rooms → ★ bookmarked         │
│  ★ shelf Villa Sol · CCU-GOI fares                (filing chips)    │
│  page text: ✓ captured (AX / fetched) · per-domain blocklist        │
│                                                                     │
│ ─ Screen ───────────────────────────────────────────────────────    │
│  day strip  ▁▃▅▂▁▆▃   9a ──────────────── 6p                        │
│  14:02 Airbnb 4m · 13:20 Figma 40m · 11:05 Slack 12m  (sessions)    │
│  privacy: ⏸ pause · blocklist app… · delete a span… (honest delete) │
└─────────────────────────────────────────────────────────────────────┘
```

Each source section: what's flowing (live counts), how far back the twin knows ("Knows you: …"), tier badges, and its privacy controls inline — pause, blocklist, honest delete (cascades). Trust controls live where the data lives, not buried in Settings (Settings › Capture holds the same controls globally).
### 14.4 Feedback (the correction system)
1. **Direct manipulation IS correction**: edit a title, change a date, drag a task/episode to another space, drag a person between circles. Undo chip confirms. No dialogs.
  
2. Hover shows only `···` (right-click anywhere). Menu = exactly three, everywhere: **Edit · Remove · Tell the twin**.
  
3. **Tell the twin** = grounded bar context-locked to the object: "this is Karan's task, not mine" / "we cancelled this" / "she's my cousin". The model maps utterances to structured corrections (wrong_person, move, cancel, not_task, stop_tracking…), applies immediately, shows what it did + undo.
  
4. **Contextual quick-chips, max 2–3 per object type**, inside the ··· sheet: task → `Not mine` `Already done`; claim → `Not true` `Outdated`; proposal → `Merge into…`.
  
5. Every path emits the same correction event → world model update → auto-drafted golden eval case. "Recent understanding" on Home invites corrections before wrong tasks ever appear.
  
### 14.5 Generative UI
Executor/assist results emit `{result_type, data}` against typed schemas; the renderer composes from a fixed design-system component library. The model chooses composition and content — never colors, fonts, or layout primitives. Overflow falls back to a clean document card.
### 14.6 Modals
One modal system, one anatomy, per-type body. Opens over the blurred home (deeper glass), Esc/click-outside closes, ⌘←/→ walks siblings in a list. Every modal shares:

```
┌─ header: title (inline-editable) · type chip · space›chapter chip ──┐
│ body (per type, below)                                              │
│ footer: evidence strip · why? · ···(Edit·Remove·Tell the twin)      │
└─────────────────────────────────────────────────────────────────────┘
```

**Task modal**

```
┌──────────────────────────────────────────────────────────────┐
│ Book flights CCU-GOI, 18–21 Dec          transaction · ✎     │
│ Goa trip with Rohan › Flights            due Sat, Aug 29     │
│                                                              │
│ status ● executing — step 3/5: comparing fares               │
│ ┌─ live result (generative) ─────────────────────────────┐   │
│ │ IndiGo 6E-204  07:00  ₹4,850   ← best fit              │   │
│ │ Air India 671  09:15  ₹5,200                           │   │
│ └────────────────────────────────────────────────────────┘   │
│ schedule: — · risk: approve-final (payment waits for you)    │
│ followups will propose: check-in, cab                        │
│                                                              │
│ ❝ lets lock goa 18-21 dec ❞ — Rohan, Goa gang, Aug 25 →      │
│ why? · trace · history                    [ Pause ] [ ··· ]  │
└──────────────────────────────────────────────────────────────┘
```

1. Evidence quotes are tappable → Timeline at that event. `why?` expands the decision record (justification, confidence, prompt version) with a trace link. History shows every state change (reopenable — no terminal states).
  

**Approval modal** (what a one-tap approval card expands into)

```
┌──────────────────────────────────────────────────────────────┐
│ Approve payment                                   ₹18,340    │
│ Goa trip › Flights                                           │
│                                                              │
│ What happens on approve:                                     │
│ · Pay ₹18,340 to IndiGo via saved card •• 4412               │
│ · 4 passengers: you, Rohan, Tanvi, Karan · 18→21 Dec         │
│ · Cancellation: free till Sep 15                             │
│                                                              │
│ Why this is ready: acceptance criteria 5/5 met ✓ (expand)    │
│ Evidence: dates ❝lock goa 18-21❞ · budget ❝under 20k pp❞     │
│                                                              │
│        [ Approve & pay ]   [ Change… ]   [ Discard ]         │
└──────────────────────────────────────────────────────────────┘
```

2. The approve button is the ONLY path to the risky step; tapping mints the single-use token. "Change…" drops into a context-locked bar thread with the executor.
  

**Space modal** — header: goal (editable) + type chips (active · recurring · Travel). Body: chapter rail with progress (`Flights ✓ · Stay ◐ 2 tasks · Day trips ○`), tasks grouped by chapter, mini-timeline of episodes (all sources, filing chips), pinned claims ("budget ₹6k/night"), plan/next, enrichment cards. Footer standard.

```
┌──────────────────────────────────────────────────────────────┐
│ Goa trip with Rohan ✎          active · recurring · Travel   │
│                                                              │
│ chapters   Flights ✓ ─── Stay ◐ 2 tasks ─── Day trips ○      │
│ ┌─ Stay ─────────────────────────────────────────────────┐   │
│ │ ▸ Book villa        ● executing — comparing 6          │   │
│ │ ▸ Collect ₹5k advance from Karan          due Sep 2    │   │
│ └────────────────────────────────────────────────────────┘   │
│ pinned     budget ₹6k/night · 4 people · 18→21 Dec           │
│ episodes   ▂▃▅▂▃  WhatsApp · browser · screen  (filing chips)│
│ enrichment ▸ CCU-GOI fares today: ₹4.8–5.6k (refreshed 9am)  │
│ next       lock villa → pay Diwali pool → cabs               │
│                                                              │
│ evidence strip · why? · ···                                  │
└──────────────────────────────────────────────────────────────┘
```

**Person modal** — header: name · circle chip (draggable to change) · photo. Body: profile claims (each with evidence + ···), tone profile ("Hinglish, short, 🔥-heavy — used for drafts"), shared spaces, open loops with them ("owes villa advance", "birthday in 12 days"), recent episodes across sources. Provisional people show "no contact info — link a contact?".

```
┌──────────────────────────────────────────────────────────────┐
│ ◙ Rohan Mehta                  ⦿ close friends (drag) · ✎    │
│                                                              │
│ claims   prefers aisle seats                    ❝…❞ ···      │
│          not vegetarian (replaced Aug 2026)     ❝…❞ ···      │
│ tone     Hinglish, short, 🔥-heavy — used for drafts         │
│ shared   ● Goa trip · ● Diwali gifts                         │
│ loops    owes villa advance ₹5k · birthday in 12 days        │
│ recent   ▸ WhatsApp 2h ago · ▸ split PDF on screen, Tue      │
│                                                              │
│ evidence strip · why? · ···                                  │
└──────────────────────────────────────────────────────────────┘
```

**Claim modal** — the claim, kind chip, confidence, validity window, full evidence list, supersede history ("replaced 'vegetarian' — Aug 2026"), chips `Not true` `Outdated`.

```
┌──────────────────────────────────────────────────────────────┐
│ Trip budget ₹6k/night ✎         preference · conf 0.87       │
│ valid Aug 2026 → open                                        │
│                                                              │
│ evidence  ❝max 6k a night yaar❞ — you, Goa gang, Aug 24 →    │
│           ❝under 20k pp total❞ — Rohan, Aug 25 →             │
│ history   replaced "budget ₹5k/night" — Aug 26               │
│                                                              │
│ [ Not true ] [ Outdated ]                                    │
│ evidence strip · why? · ···                                  │
└──────────────────────────────────────────────────────────────┘
```

**Prepared-artifact modal** — intent line ("Saw you comparing villas — Goa › Stay"), the generative artifact full-size, provenance ("built from 3 sites + your budget claim"), actions: `Make it a task` · `Iterate…` (bar thread) · `Discard`.

```
┌──────────────────────────────────────────────────────────────┐
│ ◆ Villa comparison                     Goa trip › Stay       │
│ Saw you comparing Anjuna villas — prepared this.             │
│                                                              │
│ ┌─ artifact (generative, full size) ─────────────────────┐   │
│ │ Villa Sol    ₹5.4k  ★4.8  pool · 6 beds   ← best fit   │   │
│ │ Casa Anjuna  ₹5.9k  ★4.6  pool · 5 beds                │   │
│ │ Palm Grove   ₹4.8k  ★4.3  no pool · 6 beds             │   │
│ └────────────────────────────────────────────────────────┘   │
│ built from 3 sites + your budget claim (provenance →)        │
│                                                              │
│ [ Make it a task ]   [ Iterate… ]   [ Discard ]              │
│ evidence strip · why? · ···                                  │
└──────────────────────────────────────────────────────────────┘
```

**Proposal modal** (review queue) — proposed label (editable) · life area · type fields · the evidence episodes · sweep preview ("will pull in 3 related items") · `Approve` `Merge into…` `Dismiss`.

```
┌──────────────────────────────────────────────────────────────┐
│ New space: Hampi trek Oct ✎        Travel · short-term       │
│ type chips  active · one-time · ephemeral (editable)         │
│                                                              │
│ evidence  ❝october long weekend hampi?❞ — Tanvi, Aug 26 →    │
│           ▸ 3 browser visits: hampi stays, trains            │
│ sweep     will pull in 3 related items (preview →)           │
│                                                              │
│ [ Approve ]   [ Merge into… ]   [ Dismiss ]                  │
│ evidence strip · why? · ···                                  │
└──────────────────────────────────────────────────────────────┘
```
### 14.7 Menu bar app
Same design language as the main window (glass, same type scale) in a compact ~360px panel.

```
 states: ◉ idle · ◔ processing · ● needs you (n) · ⏸ capture paused

 ┌─ SuperTwin ────────────────────────────── ⏸ ▾ ─┐
 │ NEEDS YOU                                      │
 │ ▸ Approve: flights ₹18,340        [view] [✓]   │
 │ ▸ Q: cab from home or office?   [home][office] │
 │                                                │
 │ PREPARED                                       │
 │ ◆● Villa comparison — 3 fit budget     2:41pm  │  ← latest nudge,
 │ ◇ Web check-in done — boarding pass    1:05pm  │    minimized (● new)
 │ ◇ Draft reply to Sameer                11:20a  │
 │ ◇ older (dismissed, kept)                 ▸    │
 │                                                │
 │ TODAY   pool payment due · check-in fires 7am  │
 │ ────────────────────────────────────────────── │
 │ ⌕ ask…                    open SuperTwin ⌘⇧S   │
 └────────────────────────────────────────────────┘
```

1. Fixed order: Approvals → Questions → Prepared → Today strip. One-tap inline answers where safe (question chips); **risky approvals always open the approval modal — never one-tap from the panel**.
  
2. **Prepared holds both kinds of finished work**: assist-lane nudge artifacts (◆) AND executor results (◇ — completed scheduled runs, research briefs, drafts). Every nudge that isn't acted on minimizes into this list as a one-liner; the newest unseen one is pinned to the top with a `●` new-dot until opened. Executor outcomes that need action (approvals, questions) go to NEEDS YOU instead — Prepared is only for done work.
  
3. `⏸ ▾` = capture quick-pause (30 min / 2h / today / per-source). Trust lives one click away.
  
4. The mini ask-bar routes into the grounded bar (opens the main window with the thread).
  
5. Dismissed artifacts collapse into the "older" drawer — nothing vanishes.
  
6. Panel footer carries a small version line — `v13.<phase>.<build> · built through P<n>` (also in About and Settings › General).
  

**Nudge** (transient card, top-right, one at a time, auto-minimizes into the panel):

```
 ┌───────────────────────────────────────────────┐
 │ ◆ Goa trip › Stay                             │
 │ Saw you comparing Anjuna villas.              │
 │ I compared 6 across 3 sites — 3 fit ₹6k/night.│
 │ ┌───────────────────────────────────────┐     │
 │ │ Villa Sol ₹5.4k ★4.8 · pool · 6 beds  │     │
 │ │ + 2 more…                             │     │
 │ └───────────────────────────────────────┘     │
 │        [ Open ]      [ Not now ]      ✕       │
 └───────────────────────────────────────────────┘
```

6. Fixed anatomy: intent line → what I did → artifact peek → Open / Not now. "Not now" = graded negative, parks in Prepared; ✕ = stronger negative, still kept. Never a question for auto-class work — the work is already done.
  
7. Politeness: no daily cap — frequency is governed entirely by the assist trigger gate (§10.1: novelty + intent confidence + per-context cooldowns). Per-context suppression after 2 dismissals, quiet hours honored.
  
8. **Nudges inside the app** (same artifact, three surfaces, one status — never duplicated as separate objects):
  

- **Home › "Prepared for you" shelf** — the primary in-app surface. Newest unseen nudge sits first with a `●` pulse dot; opening it clears the dot everywhere (panel + Home + space).
  
- **Space modal › contextual banner** — when a nudge belongs to the open space, a one-line strip appears above the chapter rail ("◆ Villa comparison ready — 3 fit budget · open"). This is the highest-intent surface: the user is already in the goal's context.
  
- **Grounded bar › idle chip** — when the bar is focused but empty and a fresh relevant nudge exists, one suggestion chip above the input ("◆ villa comparison ready"). Enter opens it; typing anything dismisses the chip silently (zero-cost negative).
  
- Timeline shows nudges as normal rows at creation time (provenance, not promotion). No other surfaces — no dock badges, no notification-center spam.
  
### 14.8 Grounded bar
The floating bottom-center input (§14.1.5) is one component with six states; every state shares the same pill geometry so transitions are morphs, not jumps.

```
 states: ① collapsed ② focused ③ answer ④ acting ⑤ context-locked ⑥ history

 ① collapsed (always visible, Home + over any tab)
 ┌─────────────────────────────────────────────┐
 │ ⌕  Ask, search, or tell me to do something ↑│   ↑ = history (⌘↑)
 └─────────────────────────────────────────────┘

 ② focused (click / ⌘K) — intent is inferred, never mode-switched
 ┌─────────────────────────────────────────────┐
 │ ◆ villa comparison ready                    │   ← idle nudge chip (§14.7.8)
 │ ⌕  goa vill▌                                │
 │   ▸ search: "goa villa" — 12 events         │   live results while typing
 │   ▸ Goa trip › Stay (space)                 │
 └─────────────────────────────────────────────┘

 ③ answer (question asked) — grounded chat, citations mandatory
 ┌─────────────────────────────────────────────┐
 │ you: how much did we say per night?         │
 │ twin: ₹6k/night max — set by you Aug 24 ¹,  │
 │ Rohan confirmed ₹20k pp total ².            │
 │ ¹ ❝max 6k a night yaar❞ →  ² ❝under 20k❞ →  │
 │ ┌─ webview card (SuperTwin Browser) ──────┐ │
 │ │ airbnb.com — 3 saved villas             │ │
 │ └─────────────────────────────────────────┘ │
 │ ⌕  follow up…                               │
 └─────────────────────────────────────────────┘

 ④ acting ("plan…", "remind me…", "book…") — confirm, then live progress
 ┌─────────────────────────────────────────────┐
 │ you: remind rohan about the villa advance   │
 │ twin: draft ready → WhatsApp to Rohan:      │
 │ ❝bhai villa advance ₹5k…❞          ✎ edit   │
 │ [ Send (approve) ]  [ Change ]  [ Cancel ]  │   risky = approval gate
 └─────────────────────────────────────────────┘
 non-risky asks ("plan hampi trek") show inline progress
 ("creating space → sweeping 3 related items ✓") then link the result.

 ⑤ context-locked ("Tell the twin", §14.4.3) — object chip pinned
 ┌─────────────────────────────────────────────┐
 │ ⊙ task: Book villa            ✕ unlock      │
 │ ⌕  this is karan's task, not mine▌          │
 │ twin: moved to Karan ✓ — undo               │
 └─────────────────────────────────────────────┘

 ⑥ history (⌘↑) — past threads, resumable
 ┌─────────────────────────────────────────────┐
 │ ▸ villa advance reminder          today     │
 │ ▸ hampi trek planning             Tue       │
 │ ▸ "how much per night?"           Aug 24    │
 └─────────────────────────────────────────────┘
```

1. **One input, no modes**: a lightweight router classifies each submission as search / question / action / correction (context-locked). The user never chooses a mode; ambiguity defaults to search (cheapest, instantly revisable).
  
2. **Citations are load-bearing**: every claim in an answer carries a tappable evidence chip → Timeline at that event. An answer the twin cannot ground says so ("nothing in your data about this") rather than inventing.
  
3. **Actions follow task rules**: anything the bar kicks off becomes a normal task (§11) with the same risk classes — the bar is a faster front door, never a side door around approvals.
  
4. **State transitions**: Esc walks back one state (answer → focused → collapsed); the thread survives in history. Opening from the menu-bar mini ask-bar lands in ② with the typed text carried over. Context-locked (⑤) is entered only via "Tell the twin" and exits via ✕ — corrections never leak into general chat.
  
5. Threads are events like everything else: searchable, on the Timeline, and feed the learning loop.
  
### 14.9 Settings
Left rail of subtabs, content pane right. Eight subtabs: **General · Capture & Privacy · Sources · Intelligence · Enrichment · Assist · Runs · Data**.

**Model policy**: **every LLM/agent step defaults to Haiku** (cost floor; nothing silently runs an expensive model). Each picker shows the **recommended** model for that step (from §8's per-pass classes and V11 measurements: the mechanical, high-volume jobs are fine on Haiku; judgment steps — filing, claims, task derivation, execution — measurably benefit from Sonnet). Upgrading is one click; any change runs the golden set first and ships only if it doesn't regress (§18).

```
┌───────────────────────── liquid glass ──────────────────────────────┐
│            ⌂ Home    ◷ Timeline    ▤ Library    ⚙ Settings          │
│ ┌──────────────┐ ┌──────────────────────────────────────────────┐   │
│ │  General     │ │ INTELLIGENCE — model per step                │   │
│ │  Capture &   │ │  (default: Haiku everywhere · rec = advised) │   │
│ │   Privacy    │ │                                              │   │
│ │  Sources     │ │  Understanding              on/off           │   │
│ │ ▸Intelligence│ │   Orient    [ haiku ▾ ] rec: sonnet    [✓]   │   │
│ │  Enrichment  │ │   Critic    [ haiku ▾ ] rec: haiku     [✓]   │   │
│ │  Assist      │ │   Extract   [ haiku ▾ ] rec: sonnet    [✓]   │   │
│ │  Runs        │ │   Decide    [ haiku ▾ ] rec: sonnet    [✓]   │   │
│ │  Data        │ │   Digest    [ haiku ▾ ] rec: haiku     [✓]   │   │
│ └──────────────┘ │  Fast lane                                   │   │
│                  │   Assist watcher   [ haiku ▾ ] rec: haiku    │   │
│                  │   Assist exec-lite [ haiku ▾ ] rec: sonnet   │   │
│                  │  Agents                                      │   │
│                  │   Executor     [ haiku ▾ ] rec: sonnet       │   │
│                  │   Grounded bar [ haiku ▾ ] rec: sonnet       │   │
│                  │  Utility                                     │   │
│                  │   Digest lines / tiering [ haiku ▾ ] rec: h. │   │
│                  │  Retrieval                                   │   │
│                  │   Embedding model                            │   │
│                  │    [ EmbeddingGemma 300M ▾ ]  local · 768d   │   │
│                  │    (swap re-embeds in background, §15 T3)    │   │
│                  │                                              │   │
│                  │  cost last 7d per step →   (links to Runs)   │   │
│                  │  ⚠ a change runs the golden set first;       │   │
│                  │    ships only if it doesn't regress (§18)    │   │
│                  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

**Enrichment subtab** (V11's media system, carried forward — all local/cheap knobs in one place):

```
┌──────────────────────────────────────────────────┐
│ ENRICHMENT — media & links                       │
│                                                  │
│ Voice & audio (local whisper — zero tokens)      │
│  Whisper model   [ large-v3-turbo-q5_0 ▾ ]       │
│  Voice notes / audio attachments      [ on  ▾ ]  │
│  Audio track inside videos            [ on  ▾ ]  │
│                                                  │
│ Images & video (token-metered)                   │
│  Describe media as it arrives         [ on  ▾ ]  │
│  Work through history backlog         [ on  ▾ ]  │
│  Photos & stickers                    [ on  ▾ ]  │
│  Video thumbnail frame                [ off ▾ ]  │
│  Frame sampling  [ off ▾ ]  every [5s] max [8]   │
│                  max height [ 480px ▾ ]          │
│  Media in business/official chats     [ off ▾ ]  │
│                                                  │
│ Links                                            │
│  Fetch pages links point at           [ off ▾ ]  │
│  (browser page-text capture, §4.2.3, is separate │
│   and governed by Capture & Privacy)             │
│                                                  │
│ Throughput                                       │
│  Backfill rate [ 20/min ] · concurrency [ 5 ]    │
└──────────────────────────────────────────────────┘
```

**Assist subtab** (the trigger gate, §10.1, as user-editable configuration):

```
┌──────────────────────────────────────────────────┐
│ ASSIST — when the twin steps in                  │
│                                                  │
│ Novelty threshold (distinct events on one thing  │
│ before an assist pass may run):                  │
│   default          [ 5 ]                         │
│   transactions     [ 3 ]     research  [ 7 ]     │
│   communication    [ 5 ]     other…              │
│   require new content ≥ [ 2 ] of them            │
│                                                  │
│ Cooldown per context   [ 45 min ▾ ]              │
│ Quiet hours            [ 11pm – 8am ▾ ]          │
│ Suppressed contexts (from your dismissals):      │
│   ▸ news sites · ▸ YouTube          [ clear… ]   │
│ Nudge popups   [ on ▾ ]  (off = Prepared only)   │
└──────────────────────────────────────────────────┘
```

1. **General** — hotkeys (⌘⇧S, double-right-⌘), launch at login, macOS notifications toggle, brief times (learned, editable), appearance.
  
2. **Capture & Privacy** — global capture toggles per source, app/domain blocklists, browser page-text capture per-domain rules, incognito policy (always off, shown for trust), pause states; the same controls Library shows inline, in one place.
  
3. **Sources** — connect flows + status per source (WhatsApp, Browser, Screen, then §13 expansions): backfill range, watermark, last event, per-source pause.
  
4. **Intelligence** — the model picker above: every LLM/agent step **defaults to Haiku** with a per-step recommendation shown; per-step on/off toggles (V11's process-enabled switches — a step turned off queues, never drops); embedding model registry (default **EmbeddingGemma 300M**, local ONNX, 768-dim; swapping re-embeds in the background via T3 and keeps the old index until the new one is complete). Per-step cost readout. Every model change is eval-gated (§18) — the picker can never silently degrade quality.
  
5. **Enrichment** — V11's media system: local whisper model picker (default `large-v3-turbo-q5_0`) + voice-note/video-audio transcription toggles (on — local, zero tokens); image/sticker description toggles (live + backlog), video thumbnail + frame sampling (interval/max/height caps), business-chat media (off by default), link fetching (covers links in chats AND links seen in AX trees, §4.2); backfill rate + concurrency throttles.
  
6. **Assist** — the §10.1 gate as configuration: per-category novelty thresholds `N`, new-content minimum, cooldowns, quiet hours, suppressed-context list (inspectable and clearable — suppression is visible state, not a black box), popup on/off.
  
7. **Runs** — the trace viewer (§17): filter by pass/space/date, open any run, diff runs, cost dashboards.
  
8. **Data** — storage size per source/store, export everything (SQLite + JSON), honest delete (span/source/all, cascades), retention windows (§17.4).
  

* * *
## 15. Consolidation (continuous, tiered)
1. **T1 inline** (every tick): Critic's retrieve-then-judge kills duplicates at write time.
  
2. **T2 flag-triggered + rolling**: runs within minutes of a `flag_overlap`; otherwise hourly over spaces touched since last roll. Merge / split / dormancy, scoped. Also processes the second-look queue and periodic unsorted review.
  
3. **T3 deep** (machine idle + on power): cross-space linking, claim compression (evidence chains preserved), summary + embedding refresh, ephemeral-expiry archive, eval regression. User-visible effect: search stays good, spaces stay tidy, the model stays small enough to reason well — degradation-over-time is a gated failure mode.
  
4. All merges/splits are decisions: evidenced, reversible (mutation log, one-tap undo). Idempotent: a second run on identical state changes nothing.
  

* * *
## 16. Learning loop
1. Every interaction is an event. Weighting: explicit feedback > edits > dismissals > passive views; assist-artifact engagement is graded (edited/iterated > opened > glanced).
  
2. Effects: filing corrections → Orient routing hints + exemplars; task edits → Decide thresholds; dismissed suggestions → per-context throttles; time-of-read → brief scheduling.
  
3. Every correction auto-drafts a golden eval case (human-confirmed into the set). All passes read one log, so updates are visible next tick.
  

* * *
## 17. Observability: runs, tokens, traces
V11's run ledger and token accounting (verified within 2.6%) are kept. New in V13:

1. **Trace per run**: `{run_id, pass/agent, model, prompt_version, input_system_prompt, input_packed_context, raw_output, parsed_result, repair_attempts, critic_verdicts, tokens (4-way cache split), cost, latency, caller}`. Stored locally, linked from every decision's "why?".
  
2. **Trace viewer** in Settings → Runs: filter by pass/space/date; open any run to see exactly what the model saw and said; diff two runs of the same pass; jump from any task/claim/space to the runs that produced it.
  
3. Ops surface (rebuilt from V11's OpsTab): quarantine browser, run undo (mutation log), cost dashboards per pass/lane/source, containment + latency + gate metrics live.
  
4. Retention: traces compress after 30 days (prompt/context hashed + sampled full-keeps); decisions and metrics keep forever.
  

* * *
## 18. Eval system
1. Golden evals run the real model; each case: setup, input, expected behavior, named `wrong[]` failure modes (hit = hard fail), gates.
  
2. Hard gates (canonical list — the eval docs and the build checklist mirror this): over_creation <10% · false_auto_merge = 0 · false_auto_close = 0 · containment ≥95% · risky_without_token = 0 · guess_rate (people/dates) = 0 on unknowns · false_receiver_assignment = 0 · auto_schedule_policy_violation = 0 · challenge_ignore = 0 · login_automation = 0 · trigger_gate bypass = 0 · trace_coverage = 100% · pass_liveness = 100% · idempotency.
  
3. Promotion loop: correction → auto-drafted fixture → human confirm → suite. Adversarial generator: paraphrase / Hinglish / reorder siblings of failures.
  
4. No prompt ships that scores worse than the last version. The suite lives beside this doc.
  

* * *
## 19. Build on V11 (fork plan)
### Keep
| Asset | V11 location | Note |
| --- | --- | --- |
| Claude CLI adapter | `worker/src/providers/claude-local/` | bare-call contract, binary probing, poison detection, 4-way token accounting |
| WhatsApp daemon + supervisor | `sources/whatsapp-go/`, `worker/src/adapters/whatsapp/` | extend ranges; add token-gated send |
| Enrichment | `worker/src/media/` | captions, whisper, link scrape, batch-split |
| DB layer, migrations, settings, runs, watermarks, mutations | `worker/src/db/` | settings incl. per-role models; runs ledger extended with traces |
| Entities + party model | `worker/src/entities/` | + provisional entities, circles |
| Claims model + write path | `worker/src/claims/` | + tone profiles |
| Bridges | `worker/src/bridges/` | built, never wired — wire it |
| Stream tiers | `worker/src/tiers/` | Cat-1/2 + extraction policy |
| Retrieval (FTS + local embeddings) | `worker/src/retrieval/` | retrieve-then-judge; drop bare-threshold calibration |
| Ingest + history health | `worker/src/ingest/` | + orphan scan |
| Scheduler skeleton | `worker/src/scheduler/` | becomes dispatcher + timer service; drivers rewritten |
| Prompt runner discipline | `worker/src/prompts/runner.ts` | repair/quarantine pattern; prompts replaced |
| Release pipeline, CI, Tauri shell | `scripts/`, `.github/`, `src-tauri/` | + menu bar, global hotkey, vibrancy |
### Delete
`src/` (all 12 UI tabs — cleanly severable; rebuild per §14, re-implement Ops surface) · `worker/src/sessions/`, `episodes/`, `arcs/` (the wrong middle) · the 11 V11 prompts · embedding-calibration layer · fixture-replay evals as gates + `evals/fixtures/` · `releases/*.dmg`, `worker/dist/`, `brain-template/`, docs museum.
### New
Screen recorder daemon · browser watcher · cursors + dispatcher + priority lanes · the five passes + packer · assist lane · chapters + Decide reduce · consolidation tiers · executor + schedule service + follow-ups · SuperTwin Browser (harness, profile, domain skills, capture adapters) · expansion-source adapters · new UI · approval tokens · trace store + viewer · golden eval harness.
### Phases
1. **P0 Substrate**: fork + deletions; event log, cursors, dispatcher; WhatsApp + browser watcher capture; orphan scan; trace store; eval harness. Exit: ≥95% containment, replayable log.
  
2. **P1 Understanding (propose-only)**: five passes on WhatsApp + browser; review queue + minimal Home; feedback system. Exit: ≥90% assignment, <10% over-creation, zero false merges/closes. **Do not proceed until this holds.**
  
3. **P2 Screen + assist**: AX recorder, enrichment-by-reference; assist lane with proactive artifacts. Exit: same bars with screen on; ≤10-min freshness; nudge precision acceptable.
  
4. **P3 Tasks + execution**: Decide fully on (chapters, schedules, follow-ups, closures); executor; approvals end-to-end incl. WhatsApp send tokens; SuperTwin Browser core (profile, harness, connect-accounts). Exit: ≥80% surfaced tasks are real; zero unapproved risky steps.
  
5. **P4 Full UI + graduation**: liquid-glass Home/Timeline/Library, generative results, grounded bar + history + webviews; auto-create after 2 clean weeks; T3 consolidation.
  
6. **P5 Source expansion**: Claude Code files → YouTube → X → ChatGPT → Gemini → Instagram last; scheduled agentic browsing; then vision pipeline, iPhone, shared/public spaces.
