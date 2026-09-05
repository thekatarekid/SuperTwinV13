# SuperTwin V13 — Product V4
SuperTwin is your AI digital twin. It captures your life, understands it, and acts for you. It is a private second brain, a chief of staff, and your agentic identity in the digital world.

This document says what the product is. It does not say how the code works today.

* * *
## 0. Vision
1. **A twin, not a chatbot.** It knows what you know. It does what you would do.
  
2. **Three modes.** Solo (works for you), collaborative (works with others' twins), public (represents you).
  
3. **Second brain.** Every message, page, screen, voice and note you touch becomes searchable and understood.
  
4. {==**Chief of staff.** It finds the tasks, does the busywork, and stops before the risky step.==}{>>Chief of staff or assistant. It plays these roles but this is not what it truly is. Its much more - its a digital twin of the user.<<}{id="c1" by="user" at="2026-09-04T08:33:36.181Z"}
  
5. {==**AI-first consumer product.** Delightful, present everywhere you are, never in the way.==}{>>never in the way but always with you and looking over you to help you.<<}{id="c2" by="user" at="2026-09-04T08:35:12.623Z"}
  
### Why
1. People are the duct tape between apps. The twin becomes the duct tape.
  
2. People forget what they saw. The twin remembers and finds it.
  
3. People drown in coordination. Twins coordinate with each other in seconds, not hours.
  
4. People feel pressure to keep a public presence. A public twin does it for them.
  
### Principles
1. **Capture with consent, per source.** Nothing is read before the user says yes.
  
2. **Local first.** Data lives on the user's devices. The model is the only thing that leaves.
  
3. **Minutes-fresh.** Understanding lags life by seconds to minutes. Never more than 10 minutes.
  
4. **Do, don't ask.** Prepare the safe work. Ask only at the risky step.
  
5. **Grounded.** Every task, claim, nudge and answer cites the events it came from.
  
6. **Unknown beats wrong.** Guessing a person, a date or an amount is a bug.
  
7. **Nothing is final.** Every state can reopen. Every action can undo.
  
8. **Nothing runs away.** Spend, calls and concurrency are capped in code.
  

* * *
## 1. Onboarding
Goal: something useful on screen within 2 minutes of the first connect.
### 1.1 Sources, history, permission
1. Show a source grid. Each tile: what it captures, what it never captures, what it costs.
  
2. Connect one source at a time. Each connect is its own consent card with real counts.
  
3. Two windows per source:
  
4. **Index**: kept and searchable. Default: everything. Costs disk only.
  
5. **Understand**: sent to the model. Default: last 30 days. Costs money.
  
6. Historical processing runs newest-first, one day at a time. Results stream in as they land.
  
7. macOS permissions (Accessibility, Contacts, Full Disk) are asked in context, one at a time, with a reason.
  
8. The user can skip any source and come back later. The app never blocks on a source.
  
### 1.2 User identity
1. The twin builds a **"Who I am"** card from the first data: name, city, work, people, active goals.
  
2. The user confirms or edits each line. This is the seed of the User Profile (§4.4).
  
3. The card also captures voice: language mix, tone, emoji habits. Used for drafts later.
  
4. Identity across devices is one local keypair. It signs consents, approvals and twin messages.
  
### 1.3 Login
1. **Solo mode needs no account.** No email, no password, no server.
  
2. **SuperTwin ID** is optional. It is a public key plus a handle. Needed for collaboration and public mode (§12, §13).
  
3. AI provider logins happen through the AI Connector (§2), never through us.
  

* * *
## 2. AI Connector
The twin's brain is whichever model the user already pays for. Three doors, one interface.
### 2.1 CLI adapter
1. Uses the user's installed CLI and subscription: Claude Code, Codex, Gemini CLI, Grok and others.
  
2. One adapter contract: prompt in, JSON out, per-call budget, trace out.
  
3. Tools are exposed to the CLI as MCP servers. Connector names never leave the machine.
  
4. Default door. Cheapest for heavy users.
  
### 2.2 OAuth
1. Sign in to a provider directly (Anthropic, OpenAI, Google). Token stays in Keychain.
  
2. Used when no CLI is installed, or on mobile.
  
### 2.3 OpenRouter key
1. Paste one key. Any model, any provider.
  
2. Used for cheap fast models, open models, or a specific provider the user wants.
  
### 2.4 Model roles
1. Three roles, each with its own picker: **fast** (digest, gate, critic), **deep** (understanding, planning, execution), **local** (embeddings, whisper, redaction).
  
2. Reasoning level per role.
  
3. Fallback ladder: if a door fails, the next door takes over. The user sees a banner, never silence.
  
4. Spend rails: per-call, per-hour, per-day ceilings. Breach pauses background work and asks.
  

* * *
## 3. Data Ingest and Storage
### 3.1 Sources and history
1. **Communication**: WhatsApp, iMessage, SMS, Slack, Mail, Instagram DMs, X DMs.
  
2. **Knowledge**: Apple Notes, Google Keep, Notion, Drive, Docs, Sheets, Slides, Reminders, Tasks.
  
3. **Time**: Google Calendar, Apple Calendar.
  
4. **Web**: browser history, bookmarks, tabs, page text.
  
5. **Social saves**: Instagram, X, YouTube, TikTok posts, bookmarks, watch history.
  
6. **Screen**: accessibility tree of the frontmost window, on every switch or pause.
  
7. **Audio**: meetings, calls, ambient voice on Mac and phone.
  
8. **Commerce**: Amazon, Blinkit, Zomato, Swiggy, Zepto, Uber, MakeMyTrip and others.
  
9. **Entertainment**: Netflix, Spotify, Hotstar, BookMyShow.
  
10. **AI chats**: Claude, ChatGPT, Gemini history.
  
11. **Self**: everything the user does inside SuperTwin.
  
12. Each source declares: how far back it can go, live or poll, and which door it uses (§3.3).
  
### 3.2 Input methods
Ways the user pushes things in, beyond passive capture.

1. **Apps**: share sheet on Mac and phone. Share anything to the twin.
  
2. **WhatsApp and iMessage**: message your own twin number. Text, voice, photo, forward.
  
3. **Clipboard**: watch the clipboard with a toggle. Copy something twice to send it to the twin.
  
4. **Screenshot**: any screenshot lands in the scratchpad and gets read.
  
5. **Voice input**: hold a key, speak, release. Works in any app. Dictation with intent.
  
6. **Ambient voice**: always-on mic, local transcription, speaker separation. Off by default.
  
7. **Mouse Helper**: drag a box around anything on screen. Ask about it or act on it. Works on any app, any window.
  
8. **Keyboard**: AI keyboard on phone. Suggestions and autocomplete from the twin's memory.
  
### 3.3 Connectors, Browser, Computer
Three hands. Every source and every action uses one of them.

1. **Connectors**: official APIs and exports. First choice. Fast, safe, cheap.
  
2. **Browser**: the SuperTwin Browser. One Chromium, one logged-in profile. Used for reading sites with no API and for acting on the web.
  
3. **Computer**: accessibility and input control of native apps. Used when there is no API and no web.
  
4. Rules: read-only at human cadence. Never automate login or 2FA. Stop on any challenge page.
  
### 3.4 Data filter
Privacy is enforced at capture. What never enters the log never leaks.

1. Never captured: incognito windows, password managers, secret fields, `.env`, keys, banking apps by default.
  
2. User lists: apps, sites, chats, senders, folders, calendars, people.
  
3. Time rules: quiet hours, work hours only, weekend off.
  
4. **"Forget the last N minutes"** in the menu bar. One click. Hard delete with cascade.
  
5. Per-source pause, disconnect, delete. Delete shows a preview count first.
  
6. Filters apply to index, understanding and search alike. There is no side channel.
  
### 3.5 Storage
1. One append-only event log. Raw payload kept. Text compressed.
  
2. Full-text search and chunk embeddings over everything indexed.
  
3. Screen text stored as anchor plus diff.
  
4. Budget: about 1 GB per year of life with screen on.
  
5. Encrypted at rest. Optional encrypted sync to the user's own home server (§11.6).
  

* * *
## 4. Data Processing, Organize, Understanding
### 4.1 Processing priority
1. **Live before history.** Always.
  
2. History: newest day first. Within a day: chats, then screen, then browser, then the rest.
  
3. Within a source: things the user touched first. DMs before groups. Groups the user replied in before groups they never did.
  
4. Low-signal streams get a coarse digest, later. Never dropped. One reply promotes a stream to full processing.
  
5. The user can pin a source or a chat to the front of the queue.
  
### 4.2 Chunking and episodes
1. The unit of a model call is **time, not stream**. A bundle is a few minutes of life across all sources.
  
2. Live: flush on 45 s idle or 2 min max. History: one calendar day per call.
  
3. The model cuts bundles into **episodes**: one burst of activity about one thing in one stream.
  
4. Episodes chain across time. Same topic weeks later is a new episode linked to the old.
  
5. Every episode lists its events. Every episode goes to a space or to unsorted.
  
### 4.3 Memory system
Five layers. Each layer is rebuilt from the one below it.

1. **Archive**: raw events. Immutable.
  
2. **Episodic**: episodes with summaries and evidence.
  
3. **Semantic**: claims, profile, CRM, entity graph.
  
4. **Procedural**: workflows, habits, per-site skills, per-person tone.
  
5. **Working**: the scratchpad of a running task (§5.4).
  
6. Consolidation runs continuously: dedupe at write, merge and split hourly, deep compression when idle.
  
7. Nothing is deleted by consolidation. Old claims get an end date, not a delete.
  
### 4.4 User profile
1. Basics: name, home, hometown, addresses, contacts, social handles, birthday, anniversaries.
  
2. Life: occupation, education, partner, family, friends, coworkers.
  
3. Narrative: life goals in the user's own words, refined by the twin.
  
4. Traits: claims, preferences, interests, habits, patterns, workflows (§4.10).
  
5. Voice: tone per audience. How the user talks in DMs, in groups, at work, in public.
  
6. Every line has evidence and a confidence. The user can edit any line.
  
### 4.5 Personal CRM
1. One card per person. Includes people with no contact info, built from mentions alone.
  
2. Card fields: same as the profile, plus relationship, circle, last context, open follow-ups, their goals.
  
3. Circles: partner, family, close friends, friends, coworkers, services, acquaintances, businesses.
  
4. Circles drive priority, tone, nudge thresholds and whose tasks are yours.
  
5. Follow-up radar: who owes you a reply, who you owe, birthdays and anniversaries coming up.
  
6. Merge and split people by drag. Undo always.
  
### 4.6 Spaces
A space is one goal. It is the unit of organization and of action.

1. Hierarchy: **Life area → Space → Milestone → Task**. Episodes sit beneath as evidence.
  
2. Life areas: Health, Money, Work, Travel, Home, People, Shopping, Entertainment, Learning, Admin. Editable.
  
3. Goals are **inferred** from intent, money, dates and repetition. The user edits the label and the goal.
  
4. Space properties:
  
5. Active or dormant. Dormant wakes on new signal or user ask.
  
6. Long-term or short-term.
  
7. Permanent or ephemeral. Ephemeral expires and archives.
  
8. One-time or recurring. Recurring spawns a fresh cycle each period.
  
9. Private, shared or public (§12, §13).
  
10. Solo or collaborative.
  
11. Space types set the default milestones and task templates: trip, purchase, event, health plan, subscription, project, relationship, learning, admin.
  
12. A space enriches itself with web data: prices, options, deadlines, weather, news relevant to the goal.
  
13. A space holds a plan: goal, milestones, next actions. The plan updates when the world changes.
  
14. Cross-source joins happen in the space. A chat, a page and a screen about one trip meet here.
  
15. Unsorted is a holding area, not a grave. Reviewed at every space birth.
  
### 4.7 Space list and view
1. **List**: grouped by life area. Sort by activity, deadline or user pin. Dormant collapsed.
  
2. Each row: label, area, next milestone, task count, freshness, people chips.
  
3. **View**: goal at top. Milestone rail. Task list. Prepared artifacts. Evidence timeline. People.
  
4. Every element opens a "why" panel: evidence quotes, confidence, trace.
  
5. Drag an episode or task to another space to correct filing.
  
### 4.8 Tasks
1. **Explicit**: the user or someone else said it.
  
2. **Implicit**: entailed by what happened. "Flights booked" entails "web check-in".
  
3. **Suggested**: from plan gaps. Clearly marked. At most two per space per day.
  
4. Task types: research, message, follow-up, shopping, booking, form, browse, search, filing, monitoring, errand, creation.
  
5. Risk class: auto, approve-final, approve-first, advise-only. Money and messaging are never auto.
  
6. **Scheduled tasks**: timers from computable windows. Check-in at T-48h, ticket window at 10 am. Auto only when time-bound and safe. Otherwise a confirm card.
  
7. **Follow-up tasks**: when a task closes, the twin proposes the next one or two, with the reason shown.
  
8. Owner is resolved from roles. Other people's tasks are not the user's. At most a monitoring item.
  
9. Closure needs hard evidence. One-sided intent gets "looks done, confirm?".
  
### 4.9 Prioritized task list
1. One list across all spaces. Sorted by a score: deadline, risk, value, effort, who is waiting, user pins.
  
2. Each row: title, space chip, due, status, one-tap action.
  
3. Sections: Needs you (approvals, questions) → Today → This week → Later → Waiting on others.
  
4. Filter by life area, space, person, type.
  
5. The twin explains the order on hover. The user can reorder. Reorders are learned.
  
### 4.10 Claims and traits
1. Kinds: claim, fact, belief, preference, interest, like, dislike, opinion, recommendation, try-list item, pattern, habit, workflow, relationship.
  
2. Recommendations carry a type: place, activity, recipe, product, book, show, service.
  
3. Try lists and bucket lists are first-class. "Want to try Hampi trek" becomes a dormant space seed.
  
4. Patterns are detected across time: monthly rent, Friday dinners, annual renewals, gym streaks.
  
5. Workflows are how the user does recurring things. The twin learns them and offers to run them.
  
6. Every claim: subject, evidence quote, confidence, valid from, valid to.
  
7. Contradictions never overwrite. A judge decides supersede or coexist.
  
8. Ads are never preferences. Jokes are tone, not beliefs.
  

* * *
## 5. Execution
### 5.1 Context collection
1. The executor packs: the space plan, open tasks, relevant claims, the people involved, recent episodes, and past attempts.
  
2. Retrieval, not enumeration. Top matches with quotes. Prompt size stays flat as data grows.
  
3. Web context is fetched when the task needs it: prices, availability, hours, forms.
  
4. Missing information gets one precise question. The task pauses. Never a guess.
  
### 5.2 Planning and steps
1. Plan first. Write acceptance criteria before acting.
  
2. Steps are typed: gather, research, compare, draft, fill, book, verify, report.
  
3. The risky step is always last: pay, send, book, delete, change an account.
  
4. Plans are visible. The user can edit a step or remove one before it runs.
  
### 5.3 Execution
1. Loop: act → verify against criteria → replan on failure. Never repeat a failed step unchanged.
  
2. Tools: world-model read, web fetch, drafts, files, calendar, connectors, browser, computer.
  
3. **Skills**: reusable playbooks per site and per task type. The twin writes a skill after the first success and reuses it.
  
4. Browser: agent tabs in the user's logged-in profile. Never touches the user's own tabs. Replayable.
  
5. Computer: native app control through accessibility. Same rules as browser.
  
6. Budget per task: cycles and money. On exhaustion: best partial, gaps, next idea.
  
7. Risky step is code-gated. The send path refuses without a single-use approval token.
  
### 5.4 Working memory and scratchpad
1. Each running task has a scratchpad: findings, drafts, links, screenshots, attempt log.
  
2. The user's own scratchpad (notes, clips, screenshots, voice) is a shared surface with the twin.
  
3. Scratchpad items graduate to a space, a task or a claim by one drag.
  
4. Working memory is kept after completion for review. Compressed after 30 days.
  
### 5.5 Follow-up tasks and plan
1. Completion triggers a next-step pass. Output: one or two next tasks with the reason.
  
2. Reminders, scheduled checks and monitoring items are follow-ups too.
  
3. The space plan updates. Milestones close. The next milestone becomes active.
  

* * *
## 6. UI Surface
### 6.1 Generative UI
1. Results are typed: comparison table, itinerary, draft, approval card, brief, checklist, receipt, map, calendar slot, form preview, chart.
  
2. The model picks the composition and content. The design system owns color, type and layout.
  
3. Every card is interactive: sort, filter, edit, approve, ask a follow-up.
  
4. Long text is the fallback, never the default.
  
### 6.2 Browser WebView
1. Any answer or card can embed a live page from the SuperTwin Browser.
  
2. The user finishes the risky step in the embedded page: pay, confirm, send.
  
3. Agent sessions replay as a screencast on demand.
  

* * *
## 7. Proactive Assist
### 7.1 What it does
1. Watches the last seconds of activity across sources.
  
2. Names what the user is trying to do. Only acts when it can name it.
  
3. Prepares the next step, three or four steps ahead. Comparison, draft, filled form, cart.
  
4. Auto-class only. Never pays, sends, books or changes an account.
  
### 7.2 Menu and nudge surface
1. **Nudge**: one small card, top-right, one at a time. Intent line, what I did, artifact peek, Open, Not now.
  
2. **Menu bar panel**: Needs you → Prepared → Today. Capture state and pause live here.
  
3. **Prepared shelf** on Home and in the space. Same artifact, one status, no duplicates.
  
4. Grounded bar shows one chip when a fresh relevant artifact exists.
  
5. No daily cap. Frequency comes from novelty, confidence, cooldowns and dismissals.
  
6. Quiet hours. Only a real deadline can break them.
  
7. Two dismissals in a context mutes that context. "Don't do this" is permanent until reversed.
  

* * *
## 8. Feedback and Learning
1. **Direct manipulation is correction.** Edit a title, drag a task, move a person. Undo chip. No dialogs.
  
2. One menu everywhere: Edit, Remove, Tell the twin.
  
3. **Tell the twin** locks the chat to the object. "This is Karan's, not mine." Applied at once, shown, undoable.
  
4. Quick chips per type: Not mine, Already done, Not true, Outdated, Merge into.
  
5. Signal weights: explicit feedback > edits > dismissals > views. Artifact use: edited > opened > glanced.
  
6. Effects: filing hints, task thresholds, nudge throttles, brief timing, tone.
  
7. Every correction drafts a golden eval case. No prompt ships that scores worse.
  
8. Task outcomes feed back to memory. A finished trip updates preferences, people and patterns.
  

* * *
## 9. Grounded Chat, Search, New Task, New Space
### 9.1 One bar
1. One input. No modes. The bar infers search, question, action or correction.
  
2. **Search**: instant results while typing. Events, spaces, people, tasks.
  
3. **Chat**: every answer cites events. Tap a citation to land on the timeline. No ground, no answer.
  
4. **New task**: "remind Rohan about the advance" becomes a normal task with normal risk rules.
  
5. **New space**: "plan Hampi trek in October" creates a space and sweeps related history in.
  
6. History of threads. Threads are events too.
  
### 9.2 Personality
1. Warm, brief, direct. Speaks the user's language mix.
  
2. Shows its reasoning in one line. Never lectures.
  
3. Admits gaps. "Nothing in your data about this."
  
4. Adapts register to the surface: terse in the menu bar, fuller in the space view.
  
### 9.3 Reactions, emoji, stickers, GIFs
1. When a reaction is enough, react. 👍 to "done". ✅ to an approval. 🎉 to a booked trip.
  
2. Emoji and stickers are valid replies in chat surfaces (WhatsApp, iMessage).
  
3. GIFs and stickers match the user's own habits with that person or group.
  
4. Text and reaction together are fine. Never a paragraph where a 👍 would do.
  

* * *
## 10. Apps Surface and Devices
### 10.1 Desktop and menu bar
1. Mac app, always resident. Menu bar icon shows capture and attention state.
  
2. Main window on a global hotkey. Home, Timeline, Spaces, People, Library, Settings.
  
3. Grounded bar floats over everything.
  
### 10.2 Mobile app
1. Capture: screenshots, share sheet, voice, ambient voice, clipboard, keyboard, location.
  
2. Surface: today list, nudges, approvals, chat, spaces.
  
3. Approvals on the phone approve tasks running on the Mac.
  
4. Local storage with encrypted sync to the Mac or home server.
  
### 10.3 WhatsApp, iMessage, Mail
1. The twin has its own number and address. Message it like a person.
  
2. Send a forward, a voice note, a photo, a question, or an order.
  
3. It replies in the same channel with text, reactions, stickers or a link to a card.
  
4. Approvals can be answered by reply. Risky steps still need the app's approval token.
  
### 10.4 Portable AI device
1. A small always-with-you device: mic, camera, button, no screen needed.
  
2. Captures ambient voice and photos. Answers by voice through earbuds.
  
3. Syncs to the phone. Same memory, same twin.
  
### 10.5 Home AI server
1. A box at home that runs the twin 24x7, holds all data, and runs local models.
  
2. Phone, Mac and device sync to it. The Mac can sleep.
  
3. Hosts the public twin (§13) without exposing the raw data.
  
4. Optional. Solo mode works with the Mac alone.
  

* * *
## 11. Collaboration
### 11.1 Shared and collaborative spaces and tasks
1. A space can be shared with people who have a SuperTwin ID. A trip, a wedding, a project, a flat.
  
2. Share scope is chosen per share: plan only, tasks, artifacts, or evidence too. Evidence is off by default.
  
3. Tasks in a shared space have owners across users. Each twin holds its owner's tasks.
  
4. Single-player spaces stay single-player unless shared. Sharing is reversible.
  
5. Changes sync through encrypted messages between twins. No central store.
  
### 11.2 Twin-to-twin communication
1. Twins talk to each other to settle coordination: find a time, split a bill, pick a place, confirm a plan.
  
2. Each twin speaks only for what its owner has allowed: calendar free-busy, preferences, budget range.
  
3. The result comes back as one card: "Rohan's twin says Sat works, budget ₹6k, no seafood."
  
4. Anything binding needs both owners to approve. Twins negotiate. Humans commit.
  
5. Twin messages are events. Both sides see the log.
  

* * *
## 12. Broadcast and Public
### 12.1 Public spaces
1. A space can be made public: a reading list, a travel log, a project, a portfolio, a recipe collection.
  
2. Public spaces show curated content only. Never evidence, never private people.
  
3. The twin drafts posts and updates from the space. The user approves each one.
  
4. Private is the default. Public is one explicit switch per space, with a preview.
  
### 12.2 Follow spaces
1. Anyone can follow a public space. Followers get updates in their own twin.
  
2. A followed space can feed a follower's private space. A friend's Goa list seeds your Goa trip.
  
3. Follows are consent on both sides. Blocking is one tap.
  
### 12.3 Twin-to-public-twin communication
1. A public twin answers questions on the owner's behalf within what is public.
  
2. "What does Aditya recommend in Goa?" gets an answer from the public space, with sources.
  
3. Requests that need the owner become a task for the owner's private twin.
  
4. The owner sees every public conversation. Rate limits and blocklists apply.
  

* * *
## 13. Settings the user sees
1. Per source: connect, pause, disconnect, delete, index window, understand window.
  
2. Data filters: apps, sites, chats, senders, folders, time rules.
  
3. AI connector: doors, model roles, reasoning level, spend ceilings, stop-all switch.
  
4. Assist: sensitivity, quiet hours, muted contexts.
  
5. Identity: profile card, voice, SuperTwin ID, devices.
  
6. Sharing: shared spaces, public spaces, followers, blocklist.
  
7. Runs: traces, costs, quarantine, undo log.
  

* * *
## 14. Phasing
1. **P1 Solo Mac.** Onboarding, CLI adapter, WhatsApp, browser, screen, memory, spaces, tasks, grounded bar, nudges, feedback.
  
2. **P2 More inputs.** Mail, calendar, notes, clipboard, screenshot, voice input, Mouse Helper, scratchpad, executor with browser, generative UI.
  
3. **P3 Everywhere.** Mobile app, WhatsApp and iMessage as channels, OAuth and OpenRouter doors, commerce and social sources, computer control.
  
4. **P4 Together.** SuperTwin ID, shared spaces, twin-to-twin, home server sync.
  
5. **P5 Public.** Public spaces, follows, public twin, portable device.
  

* * *
## 15. Non-goals
1. No cloud copy of raw data. Ever.
  
2. No autonomous payments, sends or bookings. The last step is always the user's.
  
3. No scraping with private-API libraries on real accounts.
  
4. No feed. The twin surfaces work, not content.
