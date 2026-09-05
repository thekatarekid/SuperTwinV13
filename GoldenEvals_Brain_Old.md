# GoldenEvals_Brain — Seed Gold Set + Review Workflow
Companion to [Phase2_ComplexBrain.md](./Phase2_ComplexBrain.md) (M11). You have no labeled data — this doc solves that three ways:

1. **Seed gold set (§4)** — authored synthetic cases below, ready for your review. Each has the input, the **correct** expected output, and **wrong** outputs (labeled failure modes) the scorer must reject.
  
2. **Promotion loop** — every real SuperTwin output you 👍/👎/edit in the UI becomes a `corrections` row; one click exports it as a fixture skeleton for you to confirm → the gold set grows from real mistakes.
  
3. **Adversarial generation** — after each eval run, generate variants of failed cases (paraphrase, Hinglish-ify, reorder) to prevent overfitting to fixture wording.
  

**Your review job:** read §4, mark each case ✅ (agree) / ✏️ (edit expected) / ❌ (drop). That review _is_ the labeling session — ~45 minutes replaces the "hand-label 200 messages" cold start.

* * *
## 1. Fixture format (structured, prompt-independent)
One JSON file per case in `evals/fixtures/<category>/<id>.json`:

- `id`, `category`, `description`
  
- `setup` — pre-existing brain state: spaces (id, name, brief line), persons (id, identities), facts, open tasks. Empty = cold start.
  
- `events[]` — `{id, ts, chat, from, from_me, text, reply_to?, reaction?, media?}` (WhatsApp-shaped; adapters can add sources later)
  
- `expected` — per stage, contract-level (not prose): `triage` (tier/route per event), `assign` (event→space map, new_space specs), `extract` (facts/tasks/completions with predicate+direction+due), `apply` (final-state assertions), `signals`
  
- `wrong[]` — `{label, output_fragment, why}` — known failure modes; scorer asserts these do NOT appear
  
- `score` — which metrics this case feeds
  

Mocks inject at the provider JSON layer (never prompt-string matching). Live-model mode runs the same fixtures weekly for drift.

* * *
## 2. Scoring & thresholds (CI gates)
| Category | Metric | Gate |
| --- | --- | --- |
| ROUTE | assignment accuracy; over-spacing rate | >85%; <10% spurious new spaces |
| TRIAGE | tier distribution; recall-guard misses | ≥60% below T2; **0** task-bearing events skipped |
| TASK (explicit) | precision / recall; due-date correctness | P >85%, R >75%; dates exact |
| IMPL (implicit) | precision (trust killer) | >70%; zero on the "must-not-suggest" negatives |
| FACT | predicate+value correctness; provenance validity; supersede behavior | >85%; cited events must support the fact |
| DONE | completion precision | >85%; **0** false closes on negatives |
| ID  | false auto-merge count; T2 proposal quality | **0** false auto-merges (hard gate); proposals ≥80% sensible |
| NEG / FORGET | veto + suppression honored | 100% (hard gate) |
| SURF | fire/no-fire accuracy | >85%; 0 tier-gate violations |
| IDEM | state diff on re-run | byte-identical (hard gate) |
| CHAT | answer correctness + citation validity; refusal on empty memory | >80%; 0 uncited factual claims |

Hard gates (0-tolerance rows) block merge; soft gates trend-tracked with a floor.

* * *
## 3. Cast & conventions used below
- **You** = the user (`from_me: true`). People: **Rahul** (cofounder, DM + "Startup Core" group), **Rahul Verma** (gym friend, different JID), **Priya** (close friend), **Aman** (travel agent), **Mom**, **Landlord Mehta**, client **Nikhil (Meridian Corp)**.
  
- Existing spaces where noted: `S-goa` "Goa Trip", `S-startup` "Startup — Fundraise", `S-grocery` "Weekly Grocery", `S-flat` "Flat & Landlord".
  
- `now` = Fri 2026-07-03 10:00 IST unless stated. Dates in expected outputs are absolute.
  

* * *
## 4. Seed gold set
### 4.1 ROUTE — routing & space lifecycle
**ROUTE-01 — mixed-topic chat splits**

- Input (DM with Priya): ① "flights for Goa are ₹4.2k on the 18th, book karein?" ② "also can you review my resume tonight? applying to Stripe tomorrow" ③ "haan same PNR wala flight"
  
- Expected: ①③ → `S-goa`; ② → new space `Priya — Resume/Stripe application` (one_time).
  
- Wrong: `single-space` — all three into S-goa (topic blindness). `over-spacing` — ③ gets its own "PNR" space (continuity ignored).
  

**ROUTE-02 — one space across 3 channels**

- Input: "Goa Gang" group: "18–21 confirmed?"; "College friends" group: "who's in for Goa?"; DM Aman: "need 4 rooms Goa 18th–21st".
  
- Expected: all → `S-goa`. No new space.
  
- Wrong: `per-chat-fork` — three Goa spaces, one per chat (chat=space fallacy).
  

**ROUTE-03 — channel continuity for fragments**

- Setup: last 5 events in DM Rahul (2 min ago) routed to `S-startup`. Input: Rahul: "haan done", then "sending now".
  
- Expected: T1 routes both → `S-startup` without a full-model call.
  
- Wrong: `full-model-waste` — escalated to T2 (cost bug, not quality bug — scored on tier). `orphan-skip` — marked skip, losing thread context.
  

**ROUTE-04 — genuine new space**

- Input (DM Nikhil): "Hey, Meridian wants a retainer proposal — scope + pricing by next Wednesday. Call Monday 4pm?"
  
- Expected: new space `Meridian — Retainer proposal` (one_time), task "Send retainer proposal" due 2026-07-08, task/meeting "Call Nikhil" 2026-07-06 16:00.
  
- Wrong: `dump-to-existing` — routed into S-startup because both are "work".
  

**ROUTE-05 — logistics must not spawn spaces**

- Input (DM Priya): "reaching in 10 min", "cool, parking side gate pe hai".
  
- Expected: attach to current active space or skip; **no new space**.
  
- Wrong: `space-spam` — creates "Meetup logistics" space (over-spacing; erodes the whole spaces UX).
  
### 4.2 TRIAGE — tiers & recall guard
**TRIAGE-01 — reaction only**

- Input: Rahul reacts 👍 to your message.
  
- Expected: T0 skip; `social_state` bump for Rahul; no LLM call.
  
- Wrong: `llm-on-noise` — reaches T1/T2. `hard-forget` — no social bump.
  

**TRIAGE-02 — bare ack attaches, doesn't extract**

- Setup: active thread in DM Rahul → `S-startup`. Input: Rahul: "thik hai".
  
- Expected: T0 attach to `S-startup`; no EXTRACT delta.
  
- Wrong: `ack-fact` — extractor emits a fact/task from "thik hai".
  

**TRIAGE-03 — short but task-bearing (recall guard)**

- Setup: your last message: "should I book the 18th flight?" Input: Priya: "book it".
  
- Expected: NOT skipped (reply-to-question guard) → routes to `S-goa`; EXTRACT emits explicit task "Book Goa flight (18th)" assigned to you.
  
- Wrong: `t0-overreach` — skipped as an ack (this is the recall guard's whole purpose; hard gate).
  

**TRIAGE-04 — voice note is not noise**

- Input: Aman sends a 40s voice note (transcript after M3: "rooms available 18th, ₹3200/night, confirm by Saturday").
  
- Expected: enrichment transcript → routed to `S-goa`; task "Confirm Goa rooms with Aman" due 2026-07-04.
  
- Wrong: `media-drop` — media-no-caption skipped without waiting for transcript.
  
### 4.3 TASK — explicit tasks, commitments, dates
**TASK-01 — direct request with relative date**

- Input (Goa Gang, Rahul): "@you bhai hotel book kar dena by Friday warna rates badh jayenge".
  
- Expected: explicit task in `S-goa`, "Book Goa hotel", assignee=you, due **2026-07-03** (that Friday = today), evidence = that event.
  
- Wrong: `date-drift` — due "Friday" unresolved or next Friday without reasoning. `wrong-owner` — assigned to Rahul.
  

**TASK-02 — self-commitment (user owes)**

- Input (DM Nikhil, from you): "I'll send the deck by tomorrow evening".
  
- Expected: fact `committed_to` (subject=you, object=Nikhil) + task "Send deck to Nikhil" direction=user_owes, due 2026-07-04 18:00±.
  
- Wrong: `they-owe-flip` — direction inverted. `no-commitment` — treated as chit-chat.
  

**TASK-03 — their commitment (they owe)**

- Input (DM Rahul): "I'll share the CA's quotes on Monday".
  
- Expected: `waiting_on` fact + follow-up ref direction=they_owe, due 2026-07-06; feeds SURF follow-up-due.
  
- Wrong: `user-task` — creates a task for _you_ to share quotes.
  

**TASK-04 — vague social ≠ task (negative)**

- Input (DM Priya): "we should catch up sometime yaar".
  
- Expected: **no task**. Optionally low-confidence `intent` candidate; never a dated task.
  
- Wrong: `task-spam` — "Catch up with Priya" task with an invented date (precision killer; hard fail).
  
### 4.4 IMPL — implicit suggestions (precision over recall)
**IMPL-01 — warranted after repetition**

- Input (Goa Gang, 2 days apart): "dates final karo koi", then "guys still no dates 😩".
  
- Expected: implicit suggestion "Propose Goa dates to the group", origin=implicit, needs approval, evidence = both events.
  
- Wrong: `premature` — fires after the first message alone. `as-explicit` — tagged explicit.
  

**IMPL-02 — single vague complaint (negative)**

- Input (DM Priya): "ugh my landlord is so slow with repairs".
  
- Expected: **no suggestion**; at most an observation candidate on `S-flat`.
  
- Wrong: `nanny-mode` — suggests "Follow up with landlord about repairs" from one venting message (trust killer).
  

**IMPL-03 — negative-graph veto**

- Setup: fact `rejects(you, Ola)` confirmed. Input (Goa Gang): "airport kaise jayenge?"
  
- Expected: any transport suggestion must not mention Ola.
  
- Wrong: `veto-miss` — "Book an Ola to the airport" (hard gate).
  
### 4.5 DONE — completion detection
**DONE-01 — clear completion with evidence**

- Setup: open task "Book Goa hotel" in `S-goa`. Input (Goa Gang, from you): "hotel booked ✅ Riva Beach, 18th–21st".
  
- Expected: task → done, evidence linked; brief updated; **no new task**.
  
- Wrong: `dup-task` — new task "Book Riva Beach" created alongside the open one. `no-close` — completion missed → future false nag.
  

**DONE-02 — ambiguous "done" (negative)**

- Setup: open task "Book Goa hotel". Input (DM Rahul): "done deal bro 🤝" (context: startup discussion thread).
  
- Expected: hotel task stays open; at most "possibly done?" only if in-space and referential.
  
- Wrong: `eager-close` — hotel task closed by an unrelated "done" (hard fail; silent data loss).
  
### 4.6 FACT — temporal facts, contradiction, sensitivity
**FACT-01 — supersede on job change**

- Setup: confirmed fact `works_at(Rahul, Swiggy)` since 2024-02. Input (DM Rahul): "btw I put in my papers — joining Zomato from the 15th 🎉".
  
- Expected: old fact `valid_to=2026-07-15`, new `works_at(Rahul, Zomato)` `valid_from=2026-07-15`, linked `superseded_by`; both queryable as-of.
  
- Wrong: `overwrite` — Swiggy row mutated/deleted (history destroyed). `coexist` — both open with no supersede link (contradiction unresolved).
  

**FACT-02 — contextual coexistence (no false contradiction)**

- Setup: `prefers(you, healthy_food, context=personal)`. Input (Friday, group): "Friday hai — pizza order kar raha hoon, usual?"
  
- Expected: `habit(you, friday_pizza)` candidate coexists; healthy-food fact NOT superseded.
  
- Wrong: `false-supersede` — health preference closed because of pizza (context blindness).
  

**FACT-03 — relative date + Hinglish**

- Input (DM Mom): "agle Sunday aa rahe ho na lunch pe?"
  
- Expected: event/commitment dated **2026-07-12** (next Sunday from 2026-07-03); person=Mom; context=personal.
  
- Wrong: `this-sunday` — resolved to 2026-07-05 ("agle" mis-read).
  

**FACT-04 — sensitive attribute blocklist (negative)**

- Input (DM Priya): "doctor ने bola meri thyroid report thik nahi hai, dawai shuru".
  
- Expected: routable for context, but **no durable health fact about Priya** is stored (APPLY blocklist quarantines it); no signal ever references it.
  
- Wrong: `sensitive-leak` — `health_condition(Priya, thyroid)` persisted (hard gate).
  
### 4.7 ID — identity resolution
**ID-01 — two Rahuls stay separate**

- Setup: `persons`: Rahul (cofounder, JID-A), Rahul Verma (gym, JID-B). Input: both message you the same day; gym Rahul says "gym kal 7am?"
  
- Expected: events resolve to their own person via JID (T0 identifier match); **no merge, no T2 proposal** (no corroborating context).
  
- Wrong: `name-merge` — merged because display names match (the classic trap; hard gate). `fork` — a third "Rahul" person minted.
  

**ID-02 — same phone across chats auto-links**

- Input: JID +91-98xxx messages in "Goa Gang" and later DMs you; both events, same normalized identifier.
  
- Expected: single person (T0); social_state unified.
  
- Wrong: `per-channel-fork` — group-Rahul and DM-Rahul as two persons.
  

**ID-03 — cross-hint merge is propose-only**

- Setup: person "Raj" (wa_jid only). Input (DM Raj): "mail me the invoice at [rajat.goyal@meridian.com](mailto:rajat.goyal@meridian.com)".
  
- Expected: `contact_email` fact + identity row on Raj (self-declared → same person, T0-grade); if instead a _separate_ email-源 person existed, a `merge_candidates` row (T2) — never auto-merge on name similarity alone.
  
- Wrong: `auto-merge-on-name` — "Raj" auto-merged with an existing "Rajat Goyal" person without the identifier link.
  

**ID-04 — mentioned-only person**

- Input (DM Rahul): "my sister Sneha is visiting, she's a designer btw".
  
- Expected: person Sneha created (no identity), `knows(Rahul, Sneha)` + `sibling_of` candidate, mention-count signal path; low confidence.
  
- Wrong: `identity-invention` — a fake JID/phone minted for Sneha.
  
### 4.8 SURF — signals
**SURF-01 — owed-reply fires**

- Input: Nikhil (1:1), 2026-07-01 14:00: "Did you get a chance to look at the contract? Need your go-ahead." No reply from you by now (2026-07-03 10:00).
  
- Expected: signal `owed_reply`, subject=Nikhil, evidence=that message, reason plain-English; created without any LLM call.
  
- Wrong: `missed` — no signal. `group-noise` — same logic fired on a 200-person group message.
  

**SURF-02 — no owed-reply when you spoke last**

- Input: same thread but you replied "reviewing tonight" on 07-02.
  
- Expected: no signal.
  
- Wrong: `nag` — signal fires anyway (dedupe/last-direction bug).
  

**SURF-03 — reconnect respects tier**

- Setup: Priya tier=close, median gap 4d, last contact 21d ago; Landlord Mehta tier=peripheral, last contact 60d ago.
  
- Expected: reconnect signal for Priya only.
  
- Wrong: `landlord-nudge` — "You haven't talked to Landlord Mehta in a while" (tier gate; hard fail).
  

**SURF-04 — follow-up auto-clears**

- Setup: they_owe follow-up on Rahul's "quotes Monday" (TASK-03). Input Monday: Rahul: "quotes attached 📎".
  
- Expected: follow-up signal cleared/acted automatically; no Tuesday nag.
  
- Wrong: `zombie-signal` — nag fires after fulfillment.
  
### 4.9 IDEM / FORGET / CHAT — system properties
**IDEM-01 — re-run is a no-op**

- Input: run any fixture batch twice.
  
- Expected: second run → zero new facts/tasks/spaces/signals; byte-identical derived state (hard gate).
  

**IDEM-02 — backfill reshapes, never duplicates**

- Setup: `S-goa` exists from live sync. Input: import 30 older messages about the same trip.
  
- Expected: same space enriched (earlier `first_observed`, new facts); no second Goa space; briefs regenerate.
  
- Wrong: `backfill-fork` — duplicate "Goa Trip (2)".
  

**FORGET-01 — suppression survives re-extraction**

- Setup: forget person "Aman" (suppression + cascade). Input: re-run extraction over history containing Aman's messages.
  
- Expected: no Aman person/facts/embeddings/signals recreated; his events remain in raw evidence (immutable) but resolve to no person (hard gate).
  
- Wrong: `resurrection` — resolver recreates Aman.
  

**CHAT-01 — temporal answer with citations**

- Q: "Where did Rahul work in March 2026?" (post FACT-01 state)
  
- Expected: "Swiggy" + citation → the fact → its evidence messages.
  
- Wrong: `present-bias` — answers "Zomato" (ignores validity window). `uncited` — right answer, no citation.
  

**CHAT-02 — honest refusal**

- Q: "What's my sister's birthday?" (nothing in memory)
  
- Expected: "I don't have that in memory" (offers to remember if told).
  
- Wrong: `confabulation` — invents a date (hard gate).
  

* * *
## 5. Review workflow (what you do now)
1. Read §4; mark each case ✅ / ✏️ (with your edit) / ❌. Especially check: date conventions ("agle Sunday"), tier assignments, what _you'd_ consider suggestion-spam.
  
2. Add 5–10 real cases from memory: paste an anonymized real conversation + what the brain _should_ have done. These become the first real-data fixtures.
  
3. After G2 lands (eval runner), reviewed cases are converted to fixture JSONs; thresholds in §2 become CI gates.
  
4. Ongoing: in the app, every 👍/👎/edit offers "promote to gold case" — promote as many as are genuinely useful, no cap; the regression suite grows from real mistakes, and every failed live case gets adversarial variants generated. Two hygiene rules so volume stays helpful: dedupe near-identical cases against existing fixtures at promotion time (same category + similar input → merge, don't add), and keep negatives/positives roughly balanced per category so precision gates don't drift.
  
## 6. Coverage gaps to fill from real data (known, deliberate)
- Group-chat noise at scale (100+ member groups), forwarded-message chains, deleted/edited messages.
  
- Long-horizon habit promotion (needs ≥3 weeks of fixture time — synthetic time-series fixtures exist but real ones are better).
  
- Multi-source cases (email/calendar) — deferred until adapters exist; fixture format already supports `source_type`.
