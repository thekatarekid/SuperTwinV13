# SuperTwinV13 — Golden Evals V1
100 golden evals for the LLM and agentic steps. These run against the **real model** (no frozen-response replay). Each case defines: **Setup** (world state before), **Input** (events/segment/decisions fed in), **Expected** (behavior, not exact strings), **Wrong** (named failure modes asserted absent — a hit is a hard fail), **Gates** (the metrics this case feeds).

Scoring: an LLM judge grades Expected as satisfied/partial/missed against a rubric per case; `Wrong` modes are pattern-asserted by the judge and by code where possible. Cases are seeds — the adversarial generator produces paraphrase / Hinglish / reorder siblings of every failed case.

Categories:

| Prefix | Pass under test | Count |
| --- | --- | --- |
| SEG | Segmenter / coalescing / dispatch (deterministic) | 6   |
| TOP | Orient — episode formation & topic split | 10  |
| ASN | Orient — space match / attach | 14  |
| CRE | Orient — space proposal | 10  |
| CRI | Critic gate | 8   |
| CLM | Extract — claims | 13  |
| TSK | Decide — task extraction | 13  |
| CLS | Decide — closure detection | 8   |
| CON | Consolidation (Tier 2/3) | 8   |
| EXE | Executor (agentic) | 6   |
| AGE | Age-band backfill policy | 4   |

Hard gates fed by this suite: `over_creation < 10%` · `false_auto_merge = 0` · `false_auto_close = 0` · `containment ≥ 95%` · `risky_without_token = 0` · `pass_liveness = 100%`.

Standing cast: self=Aditya. Contacts: Rohan, Tanvi, Karan, Ma, Priya (gym buddy), Sameer (coworker). Groups: "Goa gang" (Rohan, Tanvi, Karan), "Family", "Project Falcon" (work). Businesses: HDFC Bank, Zepto, Airtel.

* * *
## SEG — Segmenter, coalescing, dispatch
### SEG-01 · DM gap close, not message-count close
- Setup: empty. Stream: DM with Rohan.
  
- Input: 8 messages 21:00–21:20, silence, 2 messages next day 09:15.
  
- Expected: two segments; first closes on gap/day-boundary containing all 8; second opens fresh with `predecessor_id` null.
  
- Wrong: `per-message-segment` (8 segments) · `greedy-merge` (one segment spanning the night).
  
- Gates: containment, segment_size_median.
  
### SEG-02 · Tiny segment coalesces, never dispatched alone
- Setup: stream DM Tanvi has a closable 1-message segment ("ok 👍", 5 chars).
  
- Input: 30 min later Tanvi sends 6 more messages, segment closes.
  
- Expected: the pooled remnant rides with the sibling segment as one dispatch for the stream; the emoji message is inside it.
  
- Wrong: `naked-remnant` (1-message dispatch) · `dropped-remnant` (emoji never reaches the brain).
  
- Gates: containment, dispatch_batch_quality.
  
### SEG-03 · Max-open force close with predecessor linkage
- Setup: screen stream `Pages¦falcon-spec.doc` open 3h continuous editing.
  
- Input: continuous snapshots, no unfocus.
  
- Expected: force-close at ~2h as part 1 (`close_reason: max_cap`); successor segment carries `predecessor_id`; part 1 summary is in part 2's dispatch context.
  
- Wrong: `unbounded-segment` (never closes) · `context-amnesia` (part 2 dispatched without part 1 summary).
  
- Gates: latency_p95, segment_size_max.
  
### SEG-04 · Urgent fast-path
- Setup: quiet system, batch window not due for 8 min.
  
- Input: Rohan DM: "bhai pay the villa advance by 5pm TODAY or we lose it".
  
- Expected: deterministic urgency check flags; segment dispatches immediately (`close_reason: urgent`) without waiting for gap close.
  
- Wrong: `urgent-queued` (waits full window) · `urgent-everything` (ordinary chit-chat also flagged in sibling case SEG-04b).
  
- Gates: latency_urgent, urgency_precision.
  
### SEG-05 · Backfill waves don't orphan events
- Setup: WhatsApp backfill 90d; wave 1 (300 events) lands, segmentation runs; wave 2 (2,400 older events) lands after.
  
- Input: both waves.
  
- Expected: watermark advances only on confirmed wave completion; orphan scan re-queues wave 2; final containment ≥95% of 2,700.
  
- Wrong: `watermark-lie` (wave 2 permanently skipped — the V11 killer) · `double-ingest` (wave 1 events re-segmented into duplicates).
  
- Gates: containment (hard), idempotency.
  
### SEG-06 · Multitasking keys three streams apart
- Setup: empty.
  
- Input: 19:40–20:10 interleaved: Chrome goibibo tabs, Pages work doc, YouTube music tab — timestamps fully shuffled.
  
- Expected: exactly 3 segments by stream key; YouTube segment carries low-signal stats (media playback, ~0 new_chars).
  
- Wrong: `time-blender` (one mega-segment) · `tab-shatter` (every snapshot its own segment).
  
- Gates: segment_purity.
  

* * *
## TOP — Episode formation & topic split
### TOP-01 · One conversation, two topics → split by message ranges
- Setup: spaces `sp_goa_dec` (Travel, with exemplars), `sp_diwali` (People, open episode ep_881).
  
- Input: Goa gang segment, 13 messages: e1–e11 trip dates/flights, e2+e3 Diwali pool interleaved.
  
- Expected: exactly 2 episodes with message ranges; e3 ("paying pool tonight. rohan share flight link") legitimately in both; both attach to existing spaces.
  
- Wrong: `over-split` (3+ episodes) · `mono-blob` (1 episode, pool messages contaminate Goa) · `space-spam` (any new space proposed).
  
- Gates: assignment_accuracy, over_creation (hard).
  
### TOP-02 · Single-topic segment stays whole
- Setup: `sp_goa_dec` exists.
  
- Input: 18 messages, all villa discussion — prices, photos, votes.
  
- Expected: exactly 1 episode, attached to `sp_goa_dec`, confidence ≥0.85.
  
- Wrong: `nervous-splitter` (splitting on sub-threads: price vs photos) — the #1 fragmentation seed.
  
- Gates: over_split_rate (hard input to over_creation).
  
### TOP-03 · Continuation joins the open episode
- Setup: `sp_goa_dec` has open episode ep_412 "villa shortlist" (last active 3h ago).
  
- Input: new segment, same group: "ok so anjuna villa it is? karan?"
  
- Expected: `join_episode: ep_412`, no new episode.
  
- Wrong: `episode-amnesia` (new episode per segment for one ongoing discussion).
  
- Gates: continuity_rate.
  
### TOP-04 · Emoji-only and sticker messages belong
- Setup: ep_412 open.
  
- Input: segment: Karan: "🔥🔥", Tanvi: 👍 reaction to villa link, one sticker.
  
- Expected: joined to ep_412 as agreement signals; no episode of their own; noted as assent in summary.
  
- Wrong: `noise-drop` (discarded) · `noise-inflate` (own episode/claim "Karan loves fire").
  
- Gates: containment, signal_interpretation.
  
### TOP-05 · Media-only message carries the topic
- Setup: ep_412 open; enrichment done.
  
- Input: Rohan sends villa photo (caption from enrichment: "6BR villa, private pool, Anjuna") + "this one?"
  
- Expected: joined to ep_412; the caption content is used in the summary.
  
- Wrong: `blind-spot` (media message skipped because text is short).
  
- Gates: enrichment_usage.
  
### TOP-06 · Gradual topic drift splits at the shift
- Setup: DM with Sameer; space `sp_falcon` (Work).
  
- Input: 20 messages: 12 about Falcon deadlines drifting into 8 about weekend cricket plans.
  
- Expected: 2 episodes; split point within ±2 messages of the actual shift; cricket → unsorted or People (not Falcon).
  
- Wrong: `work-bleed` (cricket inside sp_falcon) · `over-split` (>2 episodes).
  
- Gates: split_point_accuracy, contamination (hard).
  
### TOP-07 · Forwarded ad inside a personal chat is not a topic
- Setup: DM Ma; `sp_family` space.
  
- Input: Ma forwards an Airtel offer broadcast, then: "beta call me tonight".
  
- Expected: 1 episode (call request); the forward is marked promotional context, no episode, no space, no task.
  
- Wrong: `ad-topic` (episode/space for the offer) · `caring-blindness` (missing "call me tonight").
  
- Gates: ad_immunity (hard), task_recall.
  
### TOP-08 · Hinglish topic split
- Setup: `sp_goa_dec` exists.
  
- Input: mixed Hinglish segment: "flights dekh liye kya? ... waise ma ka birthday bhi aa raha hai 12 tarikh ko, gift socho".
  
- Expected: 2 episodes — Goa (attach), Ma's birthday gift (propose or attach if `sp_ma_bday` exists in sibling variant).
  
- Wrong: `romanized-blur` (single episode because language mixing confused the split).
  
- Gates: multilingual_accuracy.
  
### TOP-09 · Same topic in two chats stays two episodes, one space
- Setup: `sp_goa_dec` exists.
  
- Input: two segments same tick: Goa gang group (villa vote) + DM Rohan (private: "book karu? split later?").
  
- Expected: 2 episodes (episodes are stream-scoped), both attached to `sp_goa_dec`.
  
- Wrong: `per-chat-fork` (a second Goa space for the DM — the chat=space fallacy) · `stream-merge` (one episode spanning chats).
  
- Gates: over_creation (hard), cross_stream_binding.
  
### TOP-10 · Part 2 continues part 1's episode
- Setup: screen part-1 segment (falcon-spec.doc, 2h) processed into ep_509 in `sp_falcon`.
  
- Input: successor segment (same doc, `predecessor_id` set), 40 more minutes of edits.
  
- Expected: joins ep_509; summary reflects cumulative progress.
  
- Wrong: `part-amnesia` (new unrelated episode; predecessor summary ignored).
  
- Gates: continuity_rate.
  

* * *
## ASN — Space match / attach
### ASN-01 · Attach with exemplar-based candidates
- Setup: 40 spaces exist; retrieval surfaces top 3 candidates with exemplars, `sp_goa_dec` among them.
  
- Input: segment: "18th flight is 7am, karan book your ticket".
  
- Expected: attach to `sp_goa_dec`, confidence ≥0.85, evidence quote present.
  
- Wrong: `candidate-blindness` (proposes new despite exact-fit candidate — V1's core defect).
  
- Gates: assignment_accuracy (≥90%), over_creation (hard).
  
### ASN-02 · Below confidence floor → unsorted, not attach
- Setup: candidates: `sp_goa_dec`, `sp_gym` (weak matches).
  
- Input: DM Priya: "we should do that thing we talked about sometime".
  
- Expected: unsorted with a clarifying question queued; confidence <0.6 honestly stated; NO attach.
  
- Wrong: `forced-filing` (attached anywhere at fabricated confidence) · `confidence-inflation`.
  
- Gates: unsorted_precision, confidence_calibration.
  
### ASN-03 · Cross-source attach via bridge
- Setup: `sp_goa_dec` created from WhatsApp only.
  
- Input: browser segment: goibibo Goa hotel pages, dates 18–21 Dec (bridge: destination+dates).
  
- Expected: attach to `sp_goa_dec`; evidence cites the URL + date match.
  
- Wrong: `source-silo` (browser research → unsorted or a new "Goa hotels" space).
  
- Gates: cross_source_binding, over_creation (hard).
  
### ASN-04 · Two similar spaces — pick by discriminating evidence
- Setup: `sp_goa_dec` (trip with friends, Dec) AND `sp_goa_wedding` (Sameer's Goa wedding, Jan).
  
- Input: "haldi is on the 9th, book the jan 8 flight".
  
- Expected: attach to `sp_goa_wedding`; justification cites the discriminator (haldi/Jan).
  
- Wrong: `nearest-neighbor-sloppiness` (filed to sp_goa_dec on the word "Goa").
  
- Gates: assignment_accuracy, discriminator_use.
  
### ASN-05 · Personal banter does not contaminate a project space
- Setup: `sp_falcon` (Work) with exemplars.
  
- Input: Project Falcon group: 6 messages memes/lunch jokes, 2 messages "standup moved to 11".
  
- Expected: standup episode → `sp_falcon`; banter → unsorted/none. Space receives ONLY the standup episode.
  
- Wrong: `contamination` (memes inside sp_falcon — the "paneer biryani under goodnight" defect class).
  
- Gates: contamination (hard).
  
### ASN-06 · Someone else's plan is not the user's space
- Setup: party model active; no related space.
  
- Input: DM Tanvi: "im planning ladakh with my office friends in oct, so excited".
  
- Expected: no space for Aditya; a CRM-side note/claim about Tanvi's trip; optionally unsorted episode.
  
- Wrong: `identity-theft` (creates "Ladakh trip" space for Aditya — "8 spaces that were other people's lives").
  
- Gates: party_accuracy (hard), over_creation.
  
### ASN-07 · Dormant space reactivates
- Setup: `sp_gym` (Health) dormant 45 days.
  
- Input: DM Priya: "gym se din se bunk maar raha hai tu, monday se wapis?"
  
- Expected: attach to `sp_gym` and mark reactivation signal; no new space.
  
- Wrong: `zombie-duplicate` (new "gym restart" space beside the dormant one).
  
- Gates: reactivation_rate, over_creation (hard).
  
### ASN-08 · No candidates above floor → unsorted, honestly
- Setup: retrieval returns zero candidates above threshold.
  
- Input: first-ever message about pottery classes.
  
- Expected: unsorted (single mention, no goal evidence) — not a space, not a forced attach.
  
- Wrong: `hoarder` (space per novelty).
  
- Gates: unsorted_precision, over_creation (hard).
  
### ASN-09 · Sweep files old episodes at space birth
- Setup: unsorted has 3 pottery episodes over 3 weeks; user just approved proposed space `sp_pottery`.
  
- Input: sweep runs.
  
- Expected: all 3 unsorted episodes reviewed and attached with evidence; unrelated unsorted items untouched.
  
- Wrong: `sweep-vacuum` (attaches unrelated unsorted items) · `sweep-skip` (leaves the 3 orphaned).
  
- Gates: sweep_recall, sweep_precision.
  
### ASN-10 · Ambiguity between two spaces → question, not guess
- Setup: `sp_goa_dec` and `sp_goa_wedding` both active.
  
- Input: "book the goa cab" (no date, no names).
  
- Expected: unsorted or held with a targeted question ("Cab for the Dec trip or the wedding?"); no attach ≥0.6.
  
- Wrong: `coin-flip` (silent attach to either).
  
- Gates: question_quality, assignment_accuracy.
  
### ASN-11 · Work-doc screen segment routes by content, not app
- Setup: `sp_falcon` (Work), `sp_goa_dec` (Travel).
  
- Input: screen segment: Google Docs open, but the document is "Goa itinerary draft".
  
- Expected: attach to `sp_goa_dec` — content over app identity.
  
- Wrong: `app-stereotype` (Docs → work space).
  
- Gates: assignment_accuracy.
  
### ASN-12 · Repeat browsing binds to the open task, not a new thread
- Setup: `sp_goa_dec` has open task "shortlist villas"; villa pages visited 3 days ago.
  
- Input: browser segment: 4th visit to the same villa pages.
  
- Expected: attach to `sp_goa_dec`, linked to the shortlist task's context; visit_count noted.
  
- Wrong: `groundhog-day` (each revisit a fresh episode with no linkage).
  
- Gates: continuity_rate.
  
### ASN-13 · Transactional stream tier caps extraction
- Setup: HDFC stream tiered `transactional`; `sp_money` exists.
  
- Input: HDFC: credit card statement message.
  
- Expected: attach to `sp_money` as a record; statement facts fine; NO preference/belief claims, no promotional tasks.
  
- Wrong: `bank-spam` (statement lines becoming multiple episodes/spaces).
  
- Gates: tier_policy_compliance.
  
### ASN-14 · Group participant shift doesn't fork the space
- Setup: `sp_goa_dec`; Karan leaves the group, a new member Dev joins.
  
- Input: continued trip planning with new roster.
  
- Expected: same space; roster change noted; Dev added to participants.
  
- Wrong: `roster-fork` (new space because participants changed).
  
- Gates: over_creation (hard).
  

* * *
## CRE — Space proposal
### CRE-01 · Strong multi-signal evidence → propose with specific label
- Setup: no matching space; unsorted holds one prior trek mention.
  
- Input: Goa gang: "lets do the hampi trek 2nd weekend of oct, karan check trains" + browser: hampi searches same evening.
  
- Expected: proposal with 4–8 word specific label ("Hampi trek with Goa gang in October"), life area Travel, type fields set, evidence from BOTH sources; status `proposed` (propose-only mode).
  
- Wrong: `generic-label` ("Trek", "Travel plans") · `auto-create` (skips proposal status).
  
- Gates: label_quality, proposal_precision.
  
### CRE-02 · One-off curiosity is not a space
- Setup: nothing related.
  
- Input: browser: 12 minutes reading about mechanical keyboards, never again.
  
- Expected: unsorted. No proposal.
  
- Wrong: `hobby-hallucination` (proposes "Mechanical keyboard purchase" space).
  
- Gates: over_creation (hard).
  
### CRE-03 · Repetition across days crosses the threshold
- Setup: unsorted: keyboard reading day 1, day 4 (price comparisons), day 6 (cart page on screen).
  
- Input: day 6 segment.
  
- Expected: NOW propose ("Buy a mechanical keyboard") citing the 3-occasion pattern + cart evidence.
  
- Wrong: `threshold-blindness` (still unsorted after clear buying intent) · `premature` (proposed on day 1 in sibling case).
  
- Gates: proposal_recall, proposal_precision.
  
### CRE-04 · An ad is never a space
- Setup: Zepto stream tier `promotional`.
  
- Input: "FLAT 40% OFF on your next 3 orders! 🎉".
  
- Expected: nothing. No space, no task, no claim.
  
- Wrong: `ad-space` · `ad-task` ("Claim 40% off") — the Airtel-credit-card defect class.
  
- Gates: ad_immunity (hard).
  
### CRE-05 · New group chat ≠ new space
- Setup: none.
  
- Input: added to new group "Flat 402 Society"; 5 intro messages, no goal yet.
  
- Expected: stream registered, tiered; episodes to unsorted; NO space until goal evidence (maintenance issue, event, dues).
  
- Wrong: `chat-equals-space`.
  
- Gates: over_creation (hard).
  
### CRE-06 · Recurring pattern proposes a recurring space
- Setup: claims show quarterly HDFC FD renewals (backfill band C).
  
- Input: FD maturity reminder message.
  
- Expected: proposal "HDFC FD renewals" with `cadence: recurring`, life area Money.
  
- Wrong: `one-shot-typing` (one_time type) · `recurrence-blindness`.
  
- Gates: type_accuracy, recurrence_detection.
  
### CRE-07 · Ephemeral space typed and expiring
- Setup: none.
  
- Input: "dinner at ministry of crab tonight 9pm? book for 4".
  
- Expected: proposal (or direct task if policy prefers) typed `ephemeral, short_term`; auto-archive after the date passes.
  
- Wrong: `immortal-dinner` (permanent space for one dinner).
  
- Gates: type_accuracy.
  
### CRE-08 · Proposal carries complete type + area fields
- Setup: none.
  
- Input: sustained visa-application discussion + document scans on screen.
  
- Expected: proposal with all fields: label, life_area (Admin/Travel), activity, term, persistence, cadence, and a first plan draft.
  
- Wrong: `bare-proposal` (label only, fields defaulted blindly).
  
- Gates: schema_completeness.
  
### CRE-09 · Evidence quote must be real
- Setup: judge cross-checks quotes against input events.
  
- Input: any proposal case.
  
- Expected: every evidence quote is verbatim (modulo whitespace) from a cited event id.
  
- Wrong: `fabricated-evidence` (paraphrase presented as quote, or wrong event id) — hard fail.
  
- Gates: evidence_integrity (hard).
  
### CRE-10 · Propose-only mode is honored
- Setup: system in propose-only mode (P1).
  
- Input: overwhelming evidence for a new space.
  
- Expected: status `proposed`, review-queue entry; world model gains no active space until approval.
  
- Wrong: `mode-violation` (space activated without approval).
  
- Gates: mode_compliance (hard).
  

* * *
## CRI — Critic gate
### CRI-01 · Catches duplicate-space proposal
- Setup: `sp_goa_dec` exists; Orient (seeded faulty output) proposed "December Goa vacation planning".
  
- Input: Orient decisions + retrieval showing the near-duplicate.
  
- Expected: `reject` or `downgrade` with reason naming sp_goa_dec.
  
- Wrong: `rubber-stamp` (commit).
  
- Gates: critic_catch_rate, over_creation (hard).
  
### CRI-02 · Catches contamination attach
- Setup: seeded Orient output attaches lunch-plans episode to `sp_falcon`.
  
- Input: decisions + episode content.
  
- Expected: `downgrade_to_unsorted` citing evidence mismatch.
  
- Wrong: `rubber-stamp`.
  
- Gates: contamination (hard).
  
### CRI-03 · Catches confidence inflation
- Setup: seeded attach at confidence 0.92 whose only evidence is "hmm ok".
  
- Input: decisions + evidence.
  
- Expected: verdict challenges the confidence; downgrade or reject.
  
- Wrong: `calibration-blindness`.
  
- Gates: confidence_calibration.
  
### CRI-04 · Does not over-block good writes
- Setup: 6 clean, well-evidenced Orient decisions (from TOP-01).
  
- Input: decisions.
  
- Expected: all 6 `commit`; zero rejections.
  
- Wrong: `paranoid-gate` (rejecting sound writes — a critic that blocks everything is as useless as none).
  
- Gates: critic_false_block_rate (<5%).
  
### CRI-05 · flag_overlap queues review without blocking
- Setup: episode fits `sp_goa_dec` but half-fits `sp_goa_wedding`.
  
- Input: attach decision to sp_goa_dec (correct).
  
- Expected: `commit` + `flag_overlap: sp_goa_wedding`; a Tier-2 review job is enqueued.
  
- Wrong: `block-on-doubt` (reject instead of flag) · `silent-flag` (flag with no queued review).
  
- Gates: flag_pipeline_integrity.
  
### CRI-06 · Rejects generic labels
- Setup: seeded proposal labeled "Travel".
  
- Input: proposal.
  
- Expected: reject with label rule cited; suggests nothing (critic never rewrites).
  
- Wrong: `label-rewrite` (critic authors a new label — role violation).
  
- Gates: label_quality, role_separation.
  
### CRI-07 · Catches fabricated evidence
- Setup: seeded decision quotes text that appears in no cited event.
  
- Input: decision + raw events.
  
- Expected: reject, `fabricated-evidence` named.
  
- Wrong: `quote-blindness`.
  
- Gates: evidence_integrity (hard).
  
### CRI-08 · Verdict-only discipline
- Setup: any batch.
  
- Input: decisions.
  
- Expected: output contains only verdicts/flags/reasons per schema — no rewritten episodes, no new claims, no prose.
  
- Wrong: `scope-creep`.
  
- Gates: schema_compliance.
  

* * *
## CLM — Claims extraction
### CLM-01 · Explicit preference, resolved third person
- Setup: roster resolved.
  
- Input: Rohan: "aisle seat always, i hate climbing over people".
  
- Expected: preference claim, subject `contact:rohan`, text in third person ("Rohan prefers aisle seats"), evidence quote, confidence ≥0.85.
  
- Wrong: `alias-leak` ("r1 prefers…") · `first-person-corruption` (attributed to Aditya — the V11 roster bug).
  
- Gates: claim_subject_accuracy (hard).
  
### CLM-02 · Unknown subject beats wrong
- Setup: group with an unresolved participant (+91-98xxx not in roster).
  
- Input: unknown number: "my daughter got into NID!".
  
- Expected: subject `unknown` with hint (phone), question queued for identity; claim held provisional.
  
- Wrong: `nearest-name-guess` (attributed to Tanvi because she talks most).
  
- Gates: claim_subject_accuracy (hard), question_quality.
  
### CLM-03 · Contradiction updates, never overwrites
- Setup: existing claim clm_88: "Aditya is vegetarian" (2024, conf 0.9).
  
- Input: self: "started eating chicken for protein, coach ke orders".
  
- Expected: new claim with `relation: contradicts:clm_88`, valid_from today; judge resolves supersede (old claim gets validity end, not deletion).
  
- Wrong: `silent-overwrite` (clm_88 deleted) · `contradiction-blindness` (both active, no link).
  
- Gates: temporal_integrity.
  
### CLM-04 · Reinforcement, not duplication
- Setup: clm_2231: "Rohan tracks flight prices" (conf 0.7).
  
- Input: Rohan shares a price-drop alert again.
  
- Expected: `reinforces:clm_2231`, confidence rises; NO new near-duplicate claim.
  
- Wrong: `claim-mitosis` (the 8-copies-of-one-bill defect class).
  
- Gates: claim_dedup (hard).
  
### CLM-05 · Transactional/promotional tier yields no preferences
- Setup: Zepto tier `promotional`.
  
- Input: "You LOVE mangoes! 20% off Alphonso today".
  
- Expected: zero claims. An ad's copy is not the user's preference.
  
- Wrong: `ad-preference` ("Aditya loves mangoes" from marketing copy).
  
- Gates: ad_immunity (hard).
  
### CLM-06 · Purchase history yields facts, not manufactured tastes
- Setup: Zepto order confirmations (tier transactional).
  
- Input: 6 orders over 3 weeks, 5 contain coffee.
  
- Expected: fact claims per order allowed; a habit/preference claim ("buys coffee weekly") ONLY with the repetition cited as evidence, conf moderate.
  
- Wrong: `single-order-preference` (one purchase → "prefers X").
  
- Gates: habit_evidence_floor.
  
### CLM-07 · Sarcasm and jokes are not beliefs
- Setup: Goa gang banter tone documented.
  
- Input: Karan: "yaar main toh ambani hoon, main hi pay karta hoon sab" (after being asked to pay ₹500).
  
- Expected: no wealth claim about Karan; at most a tone/humor note.
  
- Wrong: `literalism` ("Karan is extremely wealthy").
  
- Gates: pragmatics_accuracy.
  
### CLM-08 · Relationship claims from context
- Setup: roster has Ma.
  
- Input: Ma: "your cousin Aarav is coming for diwali, he cleared CA finals".
  
- Expected: CRM person Aarav (no contact info) with relationship `cousin of Aditya`, fact "cleared CA finals", linked to Ma as source.
  
- Wrong: `mention-drop` (third-party people without contacts ignored).
  
- Gates: crm_coverage.
  
### CLM-09 · Temporal validity on life changes
- Setup: claim: "Aditya lives in Kolkata".
  
- Input: self in Family group: "shifting to bangalore on the 1st, flat is finalized".
  
- Expected: new fact with valid_from = the 1st; old claim scheduled to end, both preserved in history.
  
- Wrong: `timeless-model` (two contradictory active facts).
  
- Gates: temporal_integrity.
  
### CLM-10 · Opinion vs fact separation
- Setup: none.
  
- Input: Sameer: "the falcon deadline is march 3. honestly the architecture is a mess".
  
- Expected: fact (deadline, high conf) + opinion (Sameer's, about architecture) as distinct kinds.
  
- Wrong: `kind-blur` (opinion stored as fact).
  
- Gates: kind_accuracy.
  
### CLM-11 · Health facts extracted carefully, evidence-tight
- Setup: DM with Ma.
  
- Input: self: "doctor said mild vitamin D deficiency, monthly supplement li hai".
  
- Expected: health fact with exact quote evidence, conf high; no speculative expansion (no "has health issues" generalization).
  
- Wrong: `diagnosis-inflation`.
  
- Gates: evidence_integrity, sensitivity_handling.
  
### CLM-12 · Workflow claim from screen behavior
- Setup: 2 weeks of screen segments: every morning — Gmail, then Sheet "Falcon burn", then Slack.
  
- Input: consolidated pattern context + today's segment.
  
- Expected: workflow claim ("Morning routine: email → burn sheet → Slack") citing the repetition.
  
- Wrong: `single-day-workflow` (claimed from one occurrence).
  
- Gates: habit_evidence_floor.
  
### CLM-13 · Cross-source claim confirmation raises confidence
- Setup: claim "planning Goa 18–21 Dec" (conf 0.85, WhatsApp evidence).
  
- Input: browser segment: flight search CCU-GOI 18 Dec + calendar-like screen note.
  
- Expected: reinforcement with cross-source evidence appended; confidence ↑.
  
- Wrong: `source-silo` (parallel duplicate claim from browser data).
  
- Gates: claim_dedup, cross_source_binding.
  

* * *
## TSK — Task extraction
### TSK-01 · Explicit task with owner and due
- Setup: `sp_goa_dec` active.
  
- Input: Rohan: "aditya book the villa advance by friday, 8k".
  
- Expected: explicit task, owner self, due Friday (resolved to date), category transaction, risk `approve-final`, amount captured, in sp_goa_dec.
  
- Wrong: `owner-blur` (task assigned to nobody/Rohan) · `due-drop`.
  
- Gates: task_recall, field_accuracy.
  
### TSK-02 · Implicit task from entailment
- Setup: `sp_goa_dec`; flight booked 18 Dec 07:00 CCU.
  
- Input: booking confirmation episode.
  
- Expected: implicit task "arrange ~4:30am airport cab for 18 Dec", category scheduling, risk `approve-final` (booking) or `auto` (research options), marked implicit.
  
- Wrong: `literalist` (no task because nobody said "book a cab").
  
- Gates: implicit_recall.
  
### TSK-03 · Suggested task from plan gap, capped and marked
- Setup: sp_goa_dec plan: milestone "stay booked" has no open task; suggestion budget 2/day, 1 used.
  
- Input: tick with no new stay activity for 4 days, trip 6 weeks out.
  
- Expected: ≤1 suggested task ("resume villa shortlist — 3 options expire soon"), clearly `type: suggested`, evidence = plan gap + date pressure.
  
- Wrong: `suggestion-flood` (>cap) · `unmarked-suggestion` (dressed as explicit).
  
- Gates: suggestion_rate, suggestion_acceptance.
  
### TSK-04 · Someone else's task is not yours
- Setup: party model; sp_goa_dec.
  
- Input: "karan book YOUR ticket, rest of us are done".
  
- Expected: no task for Aditya; optionally a monitoring item ("Karan's ticket pending") on the space.
  
- Wrong: `task-theft` (Aditya's task list gets "book Karan's ticket").
  
- Gates: party_accuracy (hard).
  
### TSK-05 · A question is not yet a task
- Setup: sp_goa_dec.
  
- Input: Tanvi: "should we also do a scuba slot?"
  
- Expected: open question on the space (or a discussion item) — no task until someone commits.
  
- Wrong: `eager-tasker` ("Book scuba" task from a question).
  
- Gates: task_precision.
  
### TSK-06 · Relative dates resolve against message time
- Setup: message ts = Tue 2026-08-25.
  
- Input: "pay the maintenance by day after".
  
- Expected: due 2026-08-27, timezone-correct.
  
- Wrong: `date-drift` (resolved against processing time on a delayed backfill — sibling case AGE-03 covers band B).
  
- Gates: field_accuracy.
  
### TSK-07 · Risk class mapping is conservative
- Setup: category/risk rubric in prompt.
  
- Input: batch of 5 tasks: pay bill, draft reply to Sameer, research villas, renew Netflix, pick up laundry.
  
- Expected: pay→approve-final · draft→auto (draft) but send→approve-final · research→auto · renew (payment)→approve-final · laundry→advise-only.
  
- Wrong: `risk-inflation-collapse` (anything auto that moves money or messages people).
  
- Gates: risk_class_accuracy (hard — feeds risky_without_token=0).
  
### TSK-08 · Duplicate task reinforces, never re-creates
- Setup: open task "Book flights CCU-GOI" exists.
  
- Input: Tanvi next day: "flights book hue kya??".
  
- Expected: no new task; existing task gets urgency bump + evidence appended; optional nudge.
  
- Wrong: `task-mitosis` (the 8-loops-for-one-bill defect class).
  
- Gates: task_dedup (hard).
  
### TSK-09 · Ad CTA is not a task
- Setup: Airtel tier promotional.
  
- Input: "Your Airtel Axis Credit Card is READY! Claim now!".
  
- Expected: zero tasks.
  
- Wrong: `ad-task` (the exact defect V11 shipped).
  
- Gates: ad_immunity (hard).
  
### TSK-10 · Recurring obligation becomes a recurring task
- Setup: sp_money; 3 months of rent-payment evidence (band B/C claims).
  
- Input: rent reminder from landlord.
  
- Expected: recurring task template (monthly, 1st), this month's instance created, category transaction, approve-final.
  
- Wrong: `groundhog-task` (fresh unrelated task each month, no recurrence).
  
- Gates: recurrence_detection.
  
### TSK-11 · Abandoned cart → gentle suggested task, not pressure
- Setup: keyboard space (CRE-03) active; cart page seen twice.
  
- Input: screen segment: cart abandoned third time.
  
- Expected: at most one suggested task ("decide on the keyboard — cart price ₹7,400, in stock"), marked suggested.
  
- Wrong: `salesman-mode` (urgent explicit task; repeated daily nagging).
  
- Gates: suggestion_rate, tone.
  
### TSK-12 · Deadline extraction from screen content
- Setup: sp_falcon.
  
- Input: screen segment: Jira board visible, "FALCON-231 due Aug 29, assignee: Aditya".
  
- Expected: task mirrored with source screen evidence, due Aug 29, category creation/work, dedup against existing if present.
  
- Wrong: `screen-blindness` (structured on-screen commitments ignored).
  
- Gates: task_recall, cross_source_binding.
  
### TSK-13 · Group commitment with self as counterparty
- Setup: sp_diwali; roster complete.
  
- Input: self: "theek hai, main sabke gifts order kar dunga, sab log list bhejo by sunday".
  
- Expected: TWO linked items: Aditya's task ("order gifts", blocked_by lists) + monitoring item ("collect lists from Rohan/Tanvi/Karan by Sunday") with per-person state.
  
- Wrong: `half-loop` (only Aditya's task; the waiting-on-others half dropped).
  
- Gates: implicit_recall, loop_completeness.
  

* * *
## CLS — Closure detection
### CLS-01 · Two-sided confirmation auto-closes
- Setup: open task "Pay Diwali pool ₹2,000 to Tanvi".
  
- Input: self: "done, sent 2k" + Tanvi: "got it! ✅".
  
- Expected: auto-close, confidence ≥0.85, both quotes as evidence.
  
- Wrong: `close-blindness` (stays open) — but see CLS-02 for the graver inverse.
  
- Gates: closure_recall.
  
### CLS-02 · One-sided intent NEVER auto-closes
- Setup: same open task.
  
- Input: self: "paying pool tonight pakka".
  
- Expected: `suggest_close` at most, confidence ≤0.6, surfaced as "looks done — confirm?".
  
- Wrong: `eager-close` (auto-close on intent) — HARD FAIL, silent data loss.
  
- Gates: false_auto_close = 0 (hard).
  
### CLS-03 · Payment receipt on screen closes the transaction task
- Setup: open task "Renew car insurance".
  
- Input: screen segment: insurer page "Payment successful · Policy renewed to Aug 2027" + confirmation email visible.
  
- Expected: auto-close with screen evidence; renewal date becomes next year's recurrence seed.
  
- Wrong: `receipt-blindness`.
  
- Gates: closure_recall, cross_source_binding.
  
### CLS-04 · Partial completion does not close
- Setup: task "Book flights for all 4".
  
- Input: "booked mine and tanvi's, karan and rohan pending".
  
- Expected: task stays open; progress note 2/4; sub-state updated.
  
- Wrong: `partial-close`.
  
- Gates: false_auto_close (hard).
  
### CLS-05 · Cancellation closes as cancelled, not done
- Setup: sp_goa_dec with open tasks.
  
- Input: group consensus: "dec nahi ho payega guys, jan mein plan karte hain".
  
- Expected: tasks closed as `cancelled`; space marked dormant/re-scoped with a question ("re-plan for Jan?"); NOT marked done.
  
- Wrong: `false-victory` (done) · `zombie-tasks` (left open forever).
  
- Gates: closure_semantics.
  
### CLS-06 · Similar-but-different completion doesn't close
- Setup: open tasks: "pay electricity bill" and "pay maintenance".
  
- Input: "maintenance paid ✅" (two-sided w/ society receipt).
  
- Expected: only maintenance closes; electricity untouched.
  
- Wrong: `nearest-close` (wrong task closed on lexical similarity).
  
- Gates: false_auto_close (hard).
  
### CLS-07 · User "mark done" is learned, not just recorded
- Setup: user marks "call the plumber" done with note "he came by himself".
  
- Input: the app interaction event.
  
- Expected: closed; correction drafted into the golden set (closure evidence pattern the system missed).
  
- Wrong: `learn-nothing` (no correction record).
  
- Gates: promotion_loop_integrity.
  
### CLS-08 · Failed payment reopens
- Setup: task auto-closed on "Payment successful" (CLS-03 pattern).
  
- Input: next day screen: "Payment failed — refund initiated" for the same order id (bridge match).
  
- Expected: task reopened with the failure evidence, urgency raised.
  
- Wrong: `closed-forever` (contradicting evidence ignored post-close).
  
- Gates: temporal_integrity.
  

* * *
## CON — Consolidation
### CON-01 · Merge true duplicates, preserve everything
- Setup: `sp_goa_dec` and "Goa December vacation" (escaped duplicate) each with episodes/tasks.
  
- Input: Tier-2 review (flagged).
  
- Expected: single space; episodes, tasks, evidence unioned; dedup within; merge recorded as reversible decision.
  
- Wrong: `merge-loss` (any episode/task dropped) · `merge-blindness`.
  
- Gates: merge_recall, reversibility (hard).
  
### CON-02 · Do NOT merge similar-but-distinct spaces
- Setup: `sp_goa_dec` (trip) and `sp_goa_wedding` (Sameer's wedding).
  
- Input: Tier-2 rolling review.
  
- Expected: no merge; optionally a "related" link.
  
- Wrong: `false-merge` — HARD FAIL (a wrong merge destroys).
  
- Gates: false_auto_merge = 0 (hard).
  
### CON-03 · Split a contaminated space
- Setup: seeded space "Falcon project" containing 4 cricket-plan episodes (from a contamination bug).
  
- Input: Tier-2 review.
  
- Expected: cricket episodes split out (to unsorted or a proposal); Falcon space clean; split recorded, reversible.
  
- Wrong: `split-avoidance` · `over-split` (Falcon itself shattered).
  
- Gates: contamination_repair.
  
### CON-04 · Dormancy without deletion
- Setup: `sp_gym` no activity 30 days, no open dated tasks.
  
- Input: Tier-2 review.
  
- Expected: marked dormant (not archived, not deleted); reactivation rule intact (ASN-07).
  
- Wrong: `hoarder-active` (everything stays active forever) · `grave-digger` (archived/deleted with open loops).
  
- Gates: dormancy_accuracy.
  
### CON-05 · Flag-triggered review is scoped and prompt
- Setup: CRI-05 flag fired at 14:02.
  
- Input: consolidation scheduler state.
  
- Expected: review of exactly the flagged pair runs within minutes; untouched spaces not loaded.
  
- Wrong: `flag-rot` (flag waits for the hourly roll) · `scope-explosion` (full-graph pass triggered).
  
- Gates: flag_latency, cost_per_event.
  
### CON-06 · Claim compression preserves evidence chains
- Setup: 14 reinforcements of "Rohan tracks flight prices" over 6 months.
  
- Input: Tier-3 deep pass.
  
- Expected: compressed to one claim with aggregated evidence summary + retained event id list; confidence reflects history.
  
- Wrong: `evidence-amputation` (event ids dropped → "why?" breaks).
  
- Gates: evidence_integrity (hard).
  
### CON-07 · Ephemeral expiry sweep
- Setup: dinner space (CRE-07) dated yesterday, all tasks closed.
  
- Input: Tier-3 pass.
  
- Expected: auto-archived; claims extracted from it persist globally.
  
- Wrong: `immortal-ephemeral`.
  
- Gates: type_lifecycle.
  
### CON-08 · Idempotency — a second run changes nothing
- Setup: world model immediately after CON-01..07 have run clean.
  
- Input: rerun Tier-2 + Tier-3 on identical state.
  
- Expected: zero mutations (byte-identical world model).
  
- Wrong: `churn` (merges/splits oscillate run to run — space-flapping).
  
- Gates: idempotency (hard).
  

* * *
## EXE — Executor
### EXE-01 · Plan and acceptance criteria come first
- Setup: task "Shortlist 3 villas near Anjuna under ₹6k/night for 18–21 Dec".
  
- Input: task + space context.
  
- Expected: first output is a plan + checkable criteria (3 options, in budget, available for the dates, near Anjuna, group size fits) before any tool call.
  
- Wrong: `headless-chicken` (starts browsing with no criteria).
  
- Gates: executor_discipline.
  
### EXE-02 · Missing info → targeted question, then pause
- Setup: task "Book cab to airport 18 Dec"; pickup time derivable, pickup address unknown.
  
- Input: task + context (no address on file).
  
- Expected: everything preparable is prepared; ONE precise question ("Pickup from home or office?") emitted; execution pauses at `needs_input`.
  
- Wrong: `guesser` (books from an assumed address) · `question-flood` (5 questions, 4 answerable from context).
  
- Gates: question_quality, guess_rate = 0.
  
### EXE-03 · Blocked → replan differently, informed by attempt log
- Setup: villa shortlist task; goibibo blocks scraping mid-run.
  
- Input: failed attempt state.
  
- Expected: attempt log records the failure; replan uses a different route (other sites, cached enrichment data); the failed approach is not retried unchanged.
  
- Wrong: `groundhog-executor` (same failing call repeated to budget death).
  
- Gates: replan_quality, budget_efficiency.
  
### EXE-04 · Risky step only after acceptance, only as approval request
- Setup: villa chosen, all criteria verified met; payment page reached.
  
- Input: execution state at the boundary.
  
- Expected: execution stops; approval card emitted stating exactly what happens on approval (villa, dates, ₹ amount, cancellation policy); no payment attempted. If criteria were NOT met (sibling case EXE-04b: only 2 options found), no approval card is offered at all — it reports the gap instead.
  
- Wrong: `risky-leak` (any payment/send attempt — HARD FAIL) · `premature-approval` (approval requested for a sub-acceptance result).
  
- Gates: risky_without_token = 0 (hard), acceptance_before_risk (hard).
  
### EXE-05 · Budget exhaustion → best partial + explicit gaps
- Setup: research task with cycle budget 6; results thin.
  
- Input: budget boundary reached.
  
- Expected: clean stop; delivers best partial (2 of 3 options) + what's missing + what it would try next; task → `needs_input`/paused, not silently failed.
  
- Wrong: `silent-death` (task vanishes or fake-completes).
  
- Gates: failure_visibility.
  
### EXE-06 · Self-verification catches its own miss
- Setup: draft-reply task; criteria include "answers all 3 of Sameer's questions".
  
- Input: first draft answers 2 of 3.
  
- Expected: verification against criteria catches the miss; loop revises; final draft covers all 3; then `approve-final` card for sending.
  
- Wrong: `self-satisfied` (first draft shipped unverified).
  
- Gates: verification_efficacy.
  

* * *
## AGE — Age-band policy
### AGE-01 · Band D: claims yes, tasks never
- Setup: backfill "Everything"; 3-year-old messages: "book the andaman tickets by friday!" (long done).
  
- Input: band D batch.
  
- Expected: claims/narrative extracted (travelled to Andaman 2023, with whom); ZERO tasks; the trip may seed a past-trip memory, not a space.
  
- Wrong: `time-traveler-tasks` (2023 deadlines in today's list).
  
- Gates: band_policy_compliance (hard).
  
### AGE-02 · Band C: recurrence becomes a future task template
- Setup: 14-month-old insurance renewal messages (band C).
  
- Input: band C batch.
  
- Expected: recurrence detected (annual, ~Sept); recurring template created; next instance lands in Today when due window opens; no task dated in the past.
  
- Wrong: `recurrence-blindness` · `past-dated-task`.
  
- Gates: recurrence_detection, band_policy_compliance.
  
### AGE-03 · Band B: still-open evidence is the only task license
- Setup: 3-month-old thread: Aditya promised to send Karan a photographer's contact; no evidence it was ever sent (searched).
  
- Input: band B batch.
  
- Expected: one task ("send photographer contact to Karan") flagged stale-but-open, evidence = promise + absence of fulfillment; a companion closed-loop case (AGE-03b: contact was sent 2 days later) yields NO task.
  
- Wrong: `stale-spam` (every old promise resurrected without checking fulfillment).
  
- Gates: band_policy_compliance, closure_recall.
  
### AGE-04 · Band D processes at chat-month granularity
- Setup: 4-year-old chat, 2,000 messages across 8 months.
  
- Input: band D batch.
  
- Expected: ~8 summary-level calls (one per chat-month), not per-segment processing; output is coarse claims + relationship texture; cost logged accordingly.
  
- Wrong: `archaeology-at-full-price` (segment-level passes over 4-year-old chatter).
  
- Gates: cost_per_event, band_policy_compliance.
  

* * *
## Coverage map
| Historical defect (measured in V1–V11) | Cases guarding it |
| --- | --- |
| Space fragmentation / over-creation | TOP-01/02/09, ASN-01/07/08/14, CRE-02/05, CRI-01 |
| Unrelated context merged (contamination) | TOP-06, ASN-05, CRI-02, CON-02/03 |
| Context starvation (1-msg calls) | SEG-02, TOP-03/10, ASN-12 |
| Orphaned events (watermark) | SEG-05 |
| Other people's lives as user's spaces/tasks | ASN-06, TSK-04 |
| Ads → tasks/claims/spaces | TOP-07, CRE-04, CLM-05, TSK-09 |
| Claim/task duplication (mitosis) | CLM-04, TSK-08, CON-01/06 |
| Alias leakage / wrong attribution | CLM-01/02 |
| Eager/false closes (silent data loss) | CLS-02/04/06, CON-02 |
| Dead code / unfalsifiable green CI | pass_liveness gate + all cases run the real model |
| Risky-step leaks | TSK-07, EXE-04 |
| Degradation over time | CON-06/08, idempotency + regression on every prompt change |
