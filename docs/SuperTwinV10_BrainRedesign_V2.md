# SuperTwinV10 — Brain Redesign V2
**Supersedes:** `SuperTwinV10_BrainRedesign.md` (V1). Amends `SuperTwinV10_V1.md` Parts 2, 4, 5, 6d, 8. **Grounded in:** live forensics of `~/SuperTwinV10/supertwinv10.db` — 2,815 events, 23 spaces, 13 tasks, 61 claims, 183 runs.

* * *
## 1. What changed from V1
1. **Claims and loops are orthogonal, not alternatives.** The model no longer chooses a container.
  
2. **Spaces are derived, not declared.** A space is the promoted state of an episode cluster that holds a live loop.
  
3. **Space archetypes** (project · rhythm · event · admin · watch) replace the three enum axes, and each drives its own UI.
  
4. **Personal CRM is a first-class surface**, not a byproduct. It absorbs the 8 spaces that are other people's lives.
  
5. **Goals sit above spaces** as life projects, not inside them as mandatory fields.
  
6. **The question budget is a function of returned value**, not a fixed 2/day cap.
  
7. **Graph-as-truth, encrypted, no plaintext files.** The wiki is gone; the app is the brain surface.
  

* * *
## 2. The two rules, unchanged
1. **The model judges. Code records, routes, and remembers.** Code may gate actions. Never understanding.
  
2. **Bound the loop, never the output.** Cap turns, tools, time and write scope. Never edit what the model concluded.
  

**V2 corollary:** code may compute _facts_ (dates, identity, recurrence, stake) and may narrow the model's _vocabulary_ (closed rosters, enums). Neither is a gate — both make the question answerable.

* * *
## 3. Evidence from the live run
1. **Reliability is solved.** 183 runs, 1 error. V1 Part 1 worked.
  
2. **Assign regressed to 62s average** (V8: 35s). **91 of 183 calls are escalation** — assign is unconfident half the time.
  
3. **5 of 23 spaces deserve to exist.**
  

| Category | n   | Belongs in |
| --- | --- | --- |
| Live loop + user stake | **5** | Spaces |
| Someone else's life | 8   | Person threads (CRM) |
| Pure conversation, no loop | 4   | Claims |
| Already over | 6   | Archive |

4. **Stale obligations presented as live.** `Finish iteration` — due **2026-07-20**, status `open`, priority `high`. 3.5 weeks past due.
  
5. **Another person's intention queued for auto-execution.** `Try Muesli` — `owner: Rahul Arora`, `status: queued`, `triage: auto`.
  
6. **Same content in two containers.** `Try Kalpaney` exists as a task (`owner: "unclear"` — not a valid value) _and_ as a recommendation claim from Rahul.
  
7. **Unresolved pronouns in claims.** `belief · subject: pranjali · "All dogs love me"`. In chat, "me" reads as the user.
  
8. **Misattributed claim.** `interest · subject: me · "Email copy testing — subject lines, content variations"` — that is Pranjali's work.
  
9. **The dedup gate confesses its own failure** in `gate_verdicts.reason`:
  
  - _"the cosine tiers cannot be reached inside a write transaction"_ → degenerates to exact-name match.
    
  - _"the anchor rule runs ABOVE the exact normalized-text tier, so two topics on one anchor may never collapse, however identical their names."_
    
  - Result: `Pets` + `Pets and Animals Discussion`; `Housing Search` + `Aditya - Housing Search`. **Code is structurally blocking merges the model would make.** Delete this gate.
    
10. **Identity is still a JID alias.** 104 people, 103 actors. Two id schemes coexist (`pe:gargi` vs `whatsapp:pe:<jid>`). Claims key subjects by slug string, not id.
  

* * *
## 4. System design
```
┌──────────────────────────────────────────────────────────────────────────┐
│  SOURCES        WhatsApp · (email · calendar · messages later)           │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L0  EVENTS            immutable · code · dedup on (source, external_id) │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L1  EPISODES          code · deterministic · NO model call              │
│      one chat · time gap ∪ reply chain ∪ participant shift               │
│      2,815 events  ──►  ~400-700 episodes                                │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L2  IDENTITY          code exact ─► candidate ─► agent verdict          │
│      persons (minted ids) · person_identities · merged_into tombstones   │
│      OUTPUT: the ROSTER injected into every downstream prompt            │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L3  UNDERSTAND        ONE call per episode · TWO orthogonal outputs     │
│                                                                          │
│      ┌──────────────────────┐        ┌──────────────────────────────┐   │
│      │  CLAIMS              │        │  LOOPS                       │   │
│      │  unconditional       │        │  conditional                 │   │
│      │  all of history      │        │  intent + unresolved end     │   │
│      │  fact belief pref    │        │  owner · counterparty ·      │   │
│      │  interest opinion    │        │  stake · horizon · due       │   │
│      │  recommendation      │        │                              │   │
│      │  + habit · workflow  │        │                              │   │
│      └──────────┬───────────┘        └──────────────┬───────────────┘   │
└─────────────────┼───────────────────────────────────┼───────────────────┘
                  │                                   │
                  ▼                                   ▼
┌─────────────────────────────┐      ┌────────────────────────────────────┐
│  L4a  PERSONAL CRM          │      │  L4b  SPACES (derived)             │
│  persons · relationships    │◄────►│  cluster + ≥1 live loop = space    │
│  claims by kind             │ ctx  │  archetype ► UI                    │
│  person threads             │      │  no loop ► demote ► archive        │
│  reciprocity · cadence      │      │  goals link UP to life projects    │
└─────────────────────────────┘      └────────────────────────────────────┘
                  │                                   │
                  └─────────────────┬─────────────────┘
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L5  GRAPH (SQLCipher — the only truth)                                  │
│      mutations log (append-only, provenance, undo)                       │
│      FTS5 · episode embeddings · claim embeddings                        │
└───────────────────────────────┬──────────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  L6  SURFACES     Today · Spaces · People · You · Chat · Tune            │
│      every assertion ► "why do you think this?" ► provenance ► correct   │
└──────────────────────────────────────────────────────────────────────────┘
```

* * *
## 5. Step-by-step: one message to one surface
```
STEP 1  INGEST                    code
        message ─► event (immutable, deduped)
                                   │
STEP 2  SEGMENT                   code · no model
        event ─► episode (gap ∪ reply chain ∪ participant shift)
                                   │
STEP 3  RESOLVE IDENTITY          code exact ─► candidate ─► agent
        actors ─► person_id ─► ROSTER for this episode
                                   │
STEP 4  LANE                      code (JID + outbound flag) + P9 model
        lane 1 engaged · 2 updates · 3 quiet · 4 marketing
        ── scheduling only, never whether output is kept ──
                                   │
STEP 5  UNDERSTAND                ONE model call per episode
        ├─► CLAIMS   always. history welcome. subject_id from roster.
        │            speaker_id written by CODE. attribution enum required.
        └─► LOOPS    only if: evidence of INTENT + unresolved END STATE
                                   │
STEP 6  APPLY CODE FACTS          arithmetic, not judgment
        ├─ due < now at creation      ─► born lapsed, never open
        ├─ owner ≠ me AND cpty ≠ me   ─► not a task; a fact about them
        └─ speaker ≠ subject          ─► attribution = about_other
                                   │
STEP 7  WRITE                     upsert, never insert
        claim_key / task_key / pattern_key
        exact hit ► reinforce   near hit ► supersede   contra ► supersede
                                   │
STEP 8  DERIVE THE SPACE          code
        cluster has live loop?  ── yes ─► SPACE (active)
                                ── latent only ─► SPACE (dormant)
                                └─ none ─────► no space. claims + archive.
                                   │
STEP 9  CLASSIFY ARCHETYPE        model, 1 of 5 · picks the UI
        project · rhythm · event · admin · watch
                                   │
STEP 10 ROUTE THE REST            code
        other people's forward threads ─► PERSON THREAD (CRM)
        recommendations ────────────────► person profile + space candidates
        closed / past ──────────────────► archive (retrievable, not surfaced)
                                   │
STEP 11 SURFACE                   caps are on ATTENTION, not on data
        Today · Spaces (5 archetype UIs) · People · You · Chat
        watches: ≤5 live · questions: budget by value returned
                                   │
STEP 12 CORRECT                   every gesture = a typed mutation
        wrong person · same person · not true · doesn't belong · split
        actor: user ► wins permanently ► feeds every future prompt
```

* * *
## 6. Loops vs claims — the core distinction
1. **Extract claims unconditionally.** Everything descriptive, all of history. Claims build profiles; profiles are context.
  
2. **Detect loops separately.** A loop requires **evidence of intent** _and_ an **unresolved end state**.
  
3. **The test:** evidence of _intent_ → loop. Evidence of _state_ → claim. Both, always, from the same message.
  
4. **Never route between them.** Forcing a container choice is what produced `Pets` (a claim with nowhere to go) and `Try Kalpaney` (in both containers at once).
  
5. **Latent ≠ hypothetical.**
  
  - _Latent loop_ — stated intent, nothing due today ("must move by end of 2026"). → dormant space.
    
  - _Hypothetical loop_ — the agent could imagine something. → **not a space.** A suggestion on a person or an existing space.
    
6. **Reject "an agent could help proactively" as a container test.** It is a capability test — it changes every time you ship a tool. Ontology describes the user's world; proactivity is a surface over it.
  
### Four generators of spaces — and nothing else
1. Explicit commitment with an open end state.
  
2. **Facts with a temporal boundary** — lease ends, passport expires, warranty, renewal. Currently capturing **zero** of these. Large untapped value.
  
3. Recurring obligation (habit + commitment). This is what legitimately makes `Weekend lunches` a space.
  
4. User-declared or evidence-promoted **watch**.
  

* * *
## 7. Space archetypes — and why each gets its own UI
Replaces `duration` / `cadence` / `permanence`. The archetype is the _shape of the loop_, and shape determines what a person needs to see.

| #   | Archetype | Loop shape | Primary UI |
| --- | --- | --- | --- |
| 1   | **Project** | outcome + span, many loops | milestones, task board, timeline, % to outcome |
| 2   | **Rhythm** | recurring, no end | next occurrence, streak, cadence, participants |
| 3   | **Event** | single point in time | countdown, logistics card, attendees, RSVP |
| 4   | **Admin** | recurring external duty | ledger: amount · due · paid/unpaid · account |
| 5   | **Watch** | standing attention, no obligation | findings feed, digest, sources, [Keep]/[Stop] |

1. **Archetype is chosen by the model from a fixed set of 5.** Never let the model design arbitrary UI — that is non-determinism in the interface layer.
  
2. **Modules are configurable within an archetype** (show/hide budget, map, attendees). The model may request modules; the user may pin them.
  
3. **Archetype is revisable.** A watch that grows a commitment becomes a project. Record the transition with a reason.
  
### What replaces the three enums
1. `ends_at` **(nullable)** replaces `duration` _and_ `permanence`. Has an end date → it terminates, and horizon is arithmetic. Verifiable, not judged. _Evidence: in the live DB the two enums co-vary almost perfectly — only_ `ephemeral + long_term` _carries independent information, which_ `ends_at` _expresses directly._
  
2. `cadence` (`one_time | recurring`) — keep. Genuinely orthogonal: a recurring space never completes, its loops regenerate.
  
3. `status` **becomes derived, not declared:** live loop → `active`; latent only → `dormant`; none → `archived`. _Evidence:_ `Work Iteration` _is model-set_ `dormant` _while holding a_ `high`_-priority open task 3 weeks past due._
  

* * *
## 8. Goals and life projects
1. **Goals are not mandatory on spaces.** The current prompt mandates one ("even trivial, e.g. 'groceries stocked weekly'"). Result: **3 goals across 23 spaces** — the mandate produces tautologies, not goals.
  
2. **Inconsistency to fix:** milestones already carry "ONLY when genuinely warranted, never emit empty scaffolding." Apply the same rule to goals.
  
3. **Goals live ABOVE spaces.** A **life project** is a goal object on `me/` (or on a person) that spaces link _up_ to, many-to-one.
  
  - _"Move by December 2026"_ spans housing search, budget, lease exit, movers. Modelling it inside one space is wrong containment.
    
4. **Goals emerge** when 2–3 related loops accumulate, or when the user states one. Never scaffolded.
  
5. **Life projects are the right home for the "project" framing** — the multi-year arcs (career, health, a move, a relationship) that no single space contains.
  

```
   LIFE PROJECT  "Move to a place near Indiranagar by Dec 2026"
        │
        ├── SPACE  Aditya - Housing Search      (project)
        ├── SPACE  Lease exit & deposit         (admin)
        ├── SPACE  Movers & packing             (project)
        └── SPACE  Budget for the move          (admin)
```

* * *
## 9. Watches — gate surfacing, not creation
1. **A wrong task lapses. A wrong watch nags forever.** No natural termination, so watches accumulate monotonically. That is the risk.
  
2. **Create freely; surface on evidence.** Same move as lanes: bound scheduling, never understanding.
  
3. **Latent watches** accrue evidence silently — no UI, no agent turns, no cost.
  
4. **Promotion to live requires behavioural evidence, not a model confidence score:**
  
  1. ≥3 distinct episodes, on ≥3 distinct days, spanning ≥2 weeks — recurrence, not a burst.
    
  2. The user **participated** — said something, not merely received.
    
  3. **Appears across 2+ chats.** Strongest signal: a topic recurring with multiple people is a thread of your life; a topic in one chat is a conversation.
    
5. **Cap live watches at ~5.** Scarcity forces quality; a new one must outrank an incumbent. Surfacing cap only — nothing discarded.
  
6. **Auto-dormant** after N weeks without new evidence. Self-cleaning.
  
7. **First surfacing is the confirmation**, framed as a live thing to kill, not permission to grant: _"I've been tracking speech-to-text tools — 4 mentions since July. [Keep] [Stop]"_ Ask-later beats ask-first: the proposal arrives with evidence and a working artifact.
  
8. **Interests are never watches automatically.** An interest is a disposition. It becomes a watch only via rule 4 or an explicit user act.
  

* * *
## 10. Personal CRM
The person-centric view of memory. **Spaces answer _what_. CRM answers _who_.** This is where non-actionable knowledge earns its keep, and it absorbs the 8 "someone else's life" spaces.
### 10.1 What a person record holds
1. **Identity** — canonical `person_id`, all identities (JID, phone, LID, aliases), `merged_into` chain.
  
2. **Relationship** — mother, friend, colleague, doctor, landlord — resolved from claims with confidence, asked when torn. _Currently: every person reads_ `Relationship: _Unknown._`
  
3. **Tier** — inner circle · active · dormant · archived. Derived from contact frequency and reciprocity, user-pinnable.
  
4. **Claims by kind** — facts, beliefs, preferences, interests, opinions, with confidence and evidence.
  
5. **Patterns** — their habits and workflows, subject-scoped ("mummy forwards devotional videos on Sundays").
  
6. **Person threads** — their ongoing life, narrated. **No tasks, no priority, no digest slot.** ← this is what `Rashmi - Office Transition`, `Pranjali's Housing Search`, `Email Copy Testing`, `Bhangra Classes` should have been.
  
7. **Shared spaces** — where your lives actually intersect.
  
8. **Open loops with them** — you→them, them→you. The waiting-on ledger.
  
9. **Recommendations they made** — a backlog, not a to-do list (§11).
  
10. **Contact rhythm** — expected cadence vs actual. Powers "you haven't spoken to X in 3 months."
  
11. **Reciprocity** — who asked, who answered, what went unanswered. Powers "X asked you something 6 days ago and you never replied."
  
12. **Timeline** — their episodes, claims and milestones in one chronology.
  
### 10.2 Why CRM is the right home for other people's lives
1. **A person thread is forward-looking without being an obligation.** Rashmi's office transition matters — it is context for your next conversation with her, not a project you manage.
  
2. **It surfaces at the right moment:** when you open her profile, when she messages, when you are drafting a reply — not in your task list.
  
3. **It removes 8 of 23 spaces** without losing a single fact.
  
4. **It is the highest-value screen you are not building.** 61 claims exist and no surface renders them per-person.
  
### 10.3 Claims as execution context
1. **Claims attach to people, not to spaces.** Space-relevance is **computed at query time** — storing claim↔space links is how context goes stale and duplicates.
  
2. **Relevance = subject ∈ space members ∪ semantic match to the space topic, top-K.**
  
3. **Weight preferences and constraints above facts** when the context is for _execution_ rather than recall. _"No random flatmates"_ and _"3BHK at 80K–1L is too expensive"_ are what make a housing agent useful.
  
4. **One exception worth storing:** user-pinned claims — _"always consider this here."_
  

* * *
## 11. Recommendations — a backlog, not a to-do list
1. A recommendation is **latent intent from someone else**. Not a task (the user never committed), more than a claim (it implies an action).
  
2. It lives on the **recommender's profile** and surfaces as a **candidate** inside relevant spaces — _"Rahul recommended Kalpaney"_ inside `Weekend lunches`.
  
3. It becomes a task **only when the user acts on it**.
  
4. _Evidence:_ `Try Kalpaney` _is currently both a task (_`owner: "unclear"`_) and a recommendation claim. The claim is correct; the task is the container error._
  

* * *
## 12. Identity and attribution
1. **Minted person ids**, never derived from a name or JID. `person_identities` maps many identities → one person. `merged_into` tombstones make merges O(1).
  
2. **The roster** — a closed list of `person_id`s injected into every extraction prompt. Output uses ids, never free-text names.
  
3. **Off-roster is first class:** `{"owner_id": null, "owner_hint": "the broker"}`. Unknown beats wrong.
  
4. **The attribution frame** — required on every claim:
  
  - `speaker_id` — **written by code** from the event actor. Never asked of the model.
    
  - `subject_id` — from the roster.
    
  - `addressee_id` — from the roster or the DM.
    
  - `attribution` — `first_person | about_other | reported_speech | quoted_third_party`.
    
5. **Why the enum earns its place:** `about_other` is the Abhimanyu/Rahul wedding case, structurally. `quoted_third_party` stops a forwarded article becoming the forwarder's belief. `reported_speech` discounts second-hand confidence.
  
6. **Claims are stored in resolved third person.** _Evidence:_ `belief · subject: pranjali · "All dogs love me"` _— in chat, "me" reads as the user._
  
7. **Code invariant:** `first_person` with `subject_id ≠ speaker_id` → downgrade to `about_other`, flag. A repair, never a rejection.
  

* * *
## 13. Writes, dedup, and the gate to delete
1. **Delete** `gate_verdicts` **and the anchor rule.** Its own reason text records that its cosine tiers cannot run inside a write transaction and that the anchor rule structurally prevents merges. Code blocking model judgment is a rule-1 violation and is the direct cause of `Pets` + `Pets and Animals Discussion`.
  
2. **Replace with content keys and upsert:**
  
  - `claim_key = sha1(kind | subject_id | normalize(predicate))`
    
  - `task_key = sha1(space_id | owner_id | counterparty_id | normalize(title))`
    
3. **Exact hit → reinforce** (bump evidence, union event ids, take higher confidence). This is also what graduates patterns from candidate to confirmed — no `PATTERN_MIN_EVIDENCE` constant, no code judging.
  
4. **Near hit (cosine ≥ 0.92, same subject + kind) → supersede** with reason `"refined by better evidence"`.
  
5. **Contradiction → supersede** with the model's stated reason. The chain stays queryable.
  
6. **Two-phase space commit:** proposals are _provisional_ (no id, no surface) until a batched reconcile pass compares them against each other and against committed spaces. Duplicates die at the moment they are comparable — which a single sequential pass can never provide.
  
7. **Zero model output is discarded.** Duplicates become evidence, which is strictly more information than two rows.
  

* * *
## 14. Storage, privacy, and the brain surface
1. **One SQLCipher DB is the only truth.** No `brain/` folder, no markdown, no `corpus/` plaintext dump. _(V8 wrote the entire message history to unencrypted files and deliberately did not gitignore them.)_
  
2. **Key in the OS keychain**, never leaves the device.
  
3. **Append-only** `mutations` **table replaces git:** what changed, old, new, actor (`extract | librarian | user | code`), run id, reason. This makes "undo last night's librarian run" a real button — which is what makes it safe to let agents act boldly.
  
4. **The app is the brain surface.** Three views: **People** (dossier), **Spaces** (archetype UIs), **You** (what the twin has learned).
  
5. **One affordance everywhere: "why do you think this?"** → provenance chain → source message. Better than a file: a file shows the conclusion, this shows the reasoning.
  
6. **Correction is a typed gesture, not a text diff:**
  

| Gesture | Mutation |
| --- | --- |
| wrong person | re-point `owner_id` |
| same person | `merged_into` |
| not true / not anymore | supersede, user's reason |
| doesn't belong here | move episode → space |
| this is two things | split space |
| always keep this | pin / lock from agent edits |

7. Every gesture is `actor: user`, wins permanently, and flows into every future prompt. _(Today:_ `evaluations: 0`_,_ `quality_snapshots: 0` _— the loop has never fired.)_
  

* * *
## 15. Engagement — the question budget is earned, not capped
The 2/day cap is a symptom of questions that pay nothing. Replace the constant with a **value model**.

1. **Three question channels, three budgets:**
  
  1. **Ambient** (unprompted, in Today) — stays rare, 1–2/day. Interruption is expensive.
    
  2. **Contextual** (asked where you already are — on Pranjali's profile, about Pranjali) — nearly free. The user is already in context.
    
  3. **Solicited** (a Tune session the user opens) — effectively unlimited.
    
2. **Tune sessions.** 10 questions in 90 seconds, swipeable, one tap each. Merge people, confirm relationships, resolve maybe-dones. The user opts in, so length is not an intrusion.
  
3. **Instant, visible payoff on every answer.** _"Merged — 8 items updated, 2 duplicates gone."_ The gratification must be immediate and legible, or the next answer costs more.
  
4. **Honest completeness meters** — _"Pranjali: 60% understood — 3 questions would make this 90%."_ Per person, per space, per `me/`. This is the gamification hook, and it is truthful rather than confected.
  
5. **Onboarding is your largest budget.** Users expect to be asked at setup and are most tolerant then. Front-load identity and relationship resolution.
  
6. **Just-in-time beats a queue.** Ask about a person when the user opens that person. Never accumulate 66 hedges in silence.
  
7. **Never re-ask.** Answers persist as `user`-sourced claims and corrections.
  

* * *
## 16. Sharing — hooks now, feature later
1. **Editability and visibility are orthogonal.** Two fields, not one enum: `visibility: private | link | public`, `collaborators: [twin_id]`. You will immediately want the off-diagonal cells.
  
2. **The real problem is claims, not spaces.** A shared space is only useful because its context comes along — and that context is a CRM about people who never consented.
  
3. **Claim-level policy:** claims the user authored about themselves are shareable; claims _about a person_ are never shared by default.
  
4. **Public = publishing.** A different trust posture, a different encryption story, a moderation surface. It contradicts the encrypted-local positioning.
  
5. **Build now:** `owner_id`, `visibility`, `collaborators` columns defaulting to private/solo. Retrofitting ownership onto a single-user graph is brutal.
  
6. **Build later:** any sharing UI. Sharing multiplies every quality bug across two people's trust — a wrong assignee becomes a wrong _person's_ assignee.
  
7. **The near-term version worth wanting: twin-to-twin negotiation, not shared state.** Two twins agree a dinner time by exchanging proposals — a protocol, not a shared memory. Most of the value, none of the privacy problem, and it is what makes the twin feel networked.
  

* * *
## 17. Metrics
| Metric | Now | Target |
| --- | --- | --- |
| spaces that hold a live loop with user stake | 5 / 23 (22%) | **> 90%** |
| other people's lives rendered as spaces | 8   | **0** (→ person threads) |
| tasks born past-due as `open` | 2   | **0** |
| tasks owned by a non-user, actionable | 1 (auto-queued) | **0** |
| content living in two containers | ≥1  | **0** |
| people with resolved relationship | 0   | **100%** where claims exist |
| duplicate spaces from the dedup gate | ≥2 pairs | **0** |
| assign avg duration | 62s | **< 10s** |
| escalation share of calls | 50% | **< 15%** |
| temporal-boundary facts captured (expiry, renewal) | 0   | tracked |
| model output discarded by code | 0   | **stays 0** |

**The last row is the one that killed four systems. It must never move.**

* * *
## 18. Build order
1. **Eval harness + gold set** (300–500 labelled episodes). Without it, the next iteration is another theory of the same bug.
  
2. **Delete** `gate_verdicts` **and the anchor rule.** Immediate, removes active harm.
  
3. **L1 episodes.** Biggest quality win per line of code; no model involved.
  
4. **L2 person registry + roster injection.** Fixes owner and subject errors at the root.
  
5. **Attribution frame** on claims. One prompt field, two code invariants.
  
6. **Split extract into claims (unconditional) + loops (conditional).** The core reframe.
  
7. **Code facts:** past-due → lapsed; non-user stake → claim not task.
  
8. **Spaces derived from loops** + two-phase commit + demotion to archive.
  
9. **Content keys + upsert.** Duplication stops accumulating.
  
10. **Personal CRM surface** + person threads. Absorbs 8 spaces, unlocks 61 orphaned claims.
  
11. **Archetypes + per-archetype UI.**
  
12. **Life projects** above spaces.
  
13. **Watches** with evidence-based promotion.
  
14. **Tune sessions + completeness meters.**
  
15. **Librarian, digest, proactivity** — now cheap, because it is no longer also the janitor.
  

Steps 3–9 are the thesis: **make the unit of judgment coherent, make identity a real id, make attribution structural, stop asking the model to choose a container, and make writes idempotent.** Every prior iteration attacked these with prompt wording or a validator. They are data-model problems.
