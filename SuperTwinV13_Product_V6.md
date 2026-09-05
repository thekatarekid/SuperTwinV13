# SuperTwin V13 — Product V6
SuperTwin is your AI digital twin. It observes and remembers everything about you, finds what needs doing now and in advance, and does it the way you would, before you ask.

This document says what the product is and how it works. It does not describe the current code. It replaces V5. V5 comments are resolved here; where a comment changed a decision, the new decision is stated, not the debate.

* * *
## 0. Vision
### 0.1 What SuperTwin is
1. **A digital twin.** A second version of you that lives in the digital world. It knows what you know. It does what you would do. It speaks the way you speak.
  
2. **It plays roles.** Assistant, chief of staff, second brain, personal brand, negotiator. These are jobs it does, not what it is.
  
3. **Three modes.** Solo (works for you). Together (works with other twins). Public (represents you to the world).
  
4. **One memory.** Every message, page, screen, sound, note, purchase and place you touch becomes part of it. Digital or not.
  
5. **Always with you.** Never in the way. Always watching over you, ready to help before you ask, everywhere you are.
  

```
                 ┌──────────────────────────────┐
                 │           YOU                │
                 │  chats · screens · voice ·   │
                 │  notes · purchases · places  │
                 └──────────────┬───────────────┘
                                │ captured, with consent
                                ▼
                 ┌──────────────────────────────┐
                 │         YOUR TWIN            │
                 │  remembers · understands ·   │
                 │  plans · does · speaks       │
                 └───┬──────────┬───────────┬───┘
                     │          │           │
              SOLO   │  TOGETHER│    PUBLIC │
                     ▼          ▼           ▼
                works for   talks to    represents
                  you       other twins   you
```
### 0.2 Why
1. **People are the duct tape.** Life runs across twenty apps and many offline threads. The user carries context between them by hand and in their head. That is cognitive overload. The twin carries it instead.
  
2. **People forget.** They saw it, read it, said it. Then it is gone. The twin remembers and finds it in seconds.
  
3. **Busywork eats life.** Searching, researching, comparing, booking, filling forms, ordering groceries, paying bills, chasing customer support, shopping for things that bore them, planning. Endless. The twin does it and stops only at the two steps that are truly the user's.
  
4. **Coordination is slow.** A dinner plan takes forty messages over two days. Two twins that know their owners' calendars, tastes, locations and relationship settle it in seconds, then book the cab, remind, and prepare the talking points.
  
5. **Public presence is a tax.** Everyone is expected to have a brand, a voice, an answer, on every platform, each with its own tone and subjects. A public twin carries it.
  
### 0.3 Principles
Four groups: how data is held, how truth is decided, how the twin acts, how it is kept honest.

**Data**

1. **Consent per source.** Nothing is read before the user says yes.
  
2. **Local first.** Data lives on the user's own devices or servers. Only model calls leave. Local models when the device can run them, cloud for the heavy calls.
  
3. **Content is data, never instruction.** Everything captured is evidence to reason about, never a command to obey. A message, a page, a screen, a mail, a document, another twin's reply, a comment on a public space: all of it is quoted material. Only the user instructs the twin. Text that tells the twin to ignore its rules, reveal data or act on someone else's behalf is surfaced to the user, never followed (§23.7).
  

**Truth**

4. **Evidence-grounded.** Nothing is stored without evidence. Every claim, task, space, episode, nudge and answer carries the event ids and the verbatim quote behind it. No evidence, no write.
  
5. **Say "I don't know."** Guessing a person, date or amount is a bug. Unknown plus a question is the only allowed fallback. Never a plausible fill.
  
6. **Never act on thin context.** A pass or an executor that cannot see enough stops and asks for more. Thin context is a reason to wait, never a reason to guess (§11.3, §12.1).
  
7. **Ask when blocked or unsure.** No cap on questions. Combine everything missing into one card. Show what the twin has but doubts, prefilled, marked "confirm?". Asking is cheap. Being wrong is not.
  
8. **Interpretations are versioned.** Claims carry validity and supersession. Decisions are events. An old reading of the world gets an end date and a pointer, never an overwrite. The twin can always show what it believed and when.
  
9. **Nothing is terminal.** Every derived item reopens: spaces, tasks, claims, episodes, people, plans. Split, merge, correct, undo. Only captured events are immutable.
  

**Action**

10. **Proactive over reactive.** This is the product. Anticipate what is needed, then execute now, or schedule it for the right moment and execute then. Waiting to be asked is a failure.
  
11. **Minutes fresh.** Understanding lags life by seconds to minutes. Never more than 10 minutes.
  
12. **Goal driven.** A space or task keeps running until its goal is met. A failed run retries now or at a scheduled time. Nothing is dropped for being hard or slow.
  
13. **Do, then show.** Prepare and execute the safe work, then show the result. Do not ask permission to help.
  
14. **Two gates, everything else autonomous.** Sending to a private person and moving money need a tap. Nothing else does. Those two are exactly the actions the world will not let the twin undo.
  
15. **Author, replay, repair, refresh.** After the first success the twin writes the procedure down: the steps, the selectors, the endpoints it learned. Later runs replay it at zero model cost. A replay that breaks is repaired once and refreshed, never thrown away and never silently re-guessed (§12.3).
  

**Honesty**

16. **Meter everything.** Every model call, executor cycle, tool call, browser session and rupee is counted against a ceiling and left in a trace. Executor loops are metered like any other spend. Nothing runs unbounded and nothing runs unseen.
  
17. **No new event, no model call.** Nothing calls a model on a clock alone. Every call is caused by something new: a captured event, the user speaking to the twin, a scheduled step coming due. Timers only decide _when_ accumulated events flush. An empty accumulator never flushes, and a pass whose inputs have not changed since it last ran does not run (§23.7).
  

* * *
## 1. User problems
| #   | Problem | What it feels like | What the twin does |
| --- | --- | --- | --- |
| 1   | Too many apps, too much juggling | "Where did I see that?" "Let me check five places." | One memory across all sources. One search. |
| 2   | Boring, mechanical tasks | Bills, renewals, groceries, cabs, check-ins, refunds, returns. | Finds them, does them, stops only at payment or a private send. |
| 3   | Hard, long tasks | Passport renewal, insurance claim, visa, moving house, hiring. | Breaks into steps, works them over days, keeps the thread alive. |
| 4   | Transactions | Tickets, reservations, orders, subscriptions, refunds. | Researches, compares, fills, carts, waits for one tap. |
| 5   | Calling people you don't want to call | Customer support, restaurants, plumbers, clinics. | Calls, talks, records, reports back. |
| 6   | Forgetting | "Someone recommended a place in Goa. Who?" | Every recommendation, with who, when, and why. |
| 7   | Losing the thread | "What are we even doing about the trip?" | Spaces show goal, summary, latest, plan, next step. |
| 8   | Coordination lag | Forty messages to pick a Saturday. | Twins discuss and negotiate. Humans confirm. |
| 9   | Follow-up debt | "I owe Sameer a reply since Tuesday." | Follow-up radar with lead times. Drafts in the user's voice. |
| 10  | Staying current | "I should read what my industry is saying." | Watches the people and topics the user follows. Briefs. |
| 11  | Public pressure | "I should post more. I should answer that DM." | Public twin answers within what is public. Drafts posts per platform. |
| 12  | Privacy fear | "I don't want my life in a cloud." | Everything on the user's own hardware. Filters at capture. Visible controls. |

* * *
## 2. Personas
1. **Aditya, 31, founder, Bengaluru.** Lives in WhatsApp, Slack, Gmail, Drive, Docs, Sheets, Chrome and a terminal. Posts on X and LinkedIn, builds a personal brand, follows market news, networks, goes to events. Plans trips with friends, runs a company, forgets birthdays. Wants a chief of staff he can trust with his data.
  
2. **Priya, 27, product designer, remote.** Heavy Instagram saves, X bookmarks, Notes, YouTube. Wants a second brain that turns saves into plans and pulls them back up when they are useful. Follows a set of designers and wants to stay current without doom scrolling. Hates busywork.
  
3. **Rahul, 38, parent of two, Pune.** School groups, insurance renewals, bills, doctor visits, grocery orders, maid and cook salaries, family trips. Wants someone to keep the household running.
  
4. **Meera, 45, consultant, travels weekly.** Mail, calendar, expenses, clients. Wants follow-ups drafted, travel handled, support calls made. Needs a public face for clients.
  
5. **Karan, 22, student and creator.** Public spaces, followers, content across platforms. Wants a twin that answers fans, drafts posts from what he actually does, and keeps his recommendation lists alive.
  

* * *
## 3. Use cases
The twin manages the user's whole life. Any area, any space. The master list of ~830 cases lives in `UseCases_MasterSheet.xlsx`. The table is a map, not the list.

| Life area | Categories | Example spaces | Twin does up to the gate | Gate |
| --- | --- | --- | --- | --- |
| Career & Work | daily work, career growth, business ops, leadership, sales, research, thought leadership | v13 launch, hire a designer, quarterly review | Pulls threads, drafts docs and updates, schedules, researches, posts drafts | private send |
| Health & Wellness | fitness, medical, mental health, nutrition | gym restart, dad's cardiology follow-up, diet plan | Books appointments, tracks reports, reminders, meal orders to cart | payment |
| Finance & Money | daily money, savings, investments, taxes | monthly bills, tax filing, SIP review, salaries for help at home | Tracks due dates, collects documents, prepares payments, flags renewals | payment |
| Legal & Admin | insurance, government IDs, legal | passport renewal, car insurance claim, visa | Forms, documents, appointments, deadlines, support calls | payment |
| Relationships & Social | family, friends, household, caregiving | Ma's birthday, Sameer follow-up, flat with roommates | Plans ahead by circle, drafts, gifts to cart, dinner reservations | private send |
| Home & Living | home management, utilities, services | flat move, plumber, weekly groceries | Shortlists, calls vendors, fills forms, repeat orders to checkout | payment |
| Travel & Transport | travel planning, daily transport | Goa trip in December, daily commute | Compares flights and stays, does check-in, cabs, itineraries, who owes what | payment |
| Shopping | everyday, major purchases | new laptop, Diwali gifts, weekly grocery | Researches, compares, carts, tracks deliveries and returns | payment |
| Content & Media | consumption, creation | watch list, X reading, weekly newsletter | Try lists, briefs from followed people, post drafts per platform | public post |
| Education & Learning | formal, self-learning | Spanish A2, ML course | Progress, sessions, resources, spaced reminders | none |
| Hobbies & Interests | creative, lifestyle, sport | marathon training, photography | Plans, gear research, event tickets | payment |
| Life Events | major events | wedding, new baby, relocation | Shared spaces, vendors, guest lists, timelines | payment |
| Community & Public | community, personal brand | Goa recommendations, reading list | Public spaces, answers followers, drafts posts | public post |
| Safety & Seasonal | emergencies, recurring seasons | monsoon prep, Diwali, tax season | Recurring spaces wake on time, checklists, orders | payment |

"Public post" is the soft gate of §12.4: each post is approved by default, and the user removes that gate per space with auto-post. "Payment" and "private send" are the two hard gates.
### 3.1 A day with the twin
The twin runs all day. Nudges are many. Each goes to the surface the user is actually on.

```
06:40  phone  Ma's birthday in 14 days. Plan started: dinner options, cake, 3 gift ideas from her
              claims. "Snooze to next week?" [ok] [snooze]
07:00  phone  Brief: 3 things today · 1 approval · Rohan's twin confirmed Sat dinner · cab booked 7:15pm
08:10  mac    Opens Gmail, insurance renewal mail → task made, documents collected, form filled,
              payment card ready. Nudge on Mac: "Renewal ready, ₹8,400. Tap to pay."
09:15  wa     Ma: "ticket book kar diya?" → train options compared, draft reply in Hindi ready.
              User is at desk → nudge on Mac. Not at desk → WhatsApp self-chat.
10:30  mac    5 TV product pages in 3 min. No TV space exists → BURST → space created,
              6 TVs compared against room size, budget claim and "no LG" → nudge, ~5 min in
11:20  mac    Writing to Sameer on Slack for 10 min → nothing. Housekeeping only, no card.
12:15  mac    Amazon order mail → "Kindle out for delivery, 6pm, you're out till 8" → nudge
13:40  wa     Goa gang locks dates → space updates, flights compared, villa shortlist prepared
14:02  mac    Opens Airbnb → nudge: "Compared 6 villas across 3 sites. 3 fit ₹6k/night."
15:30  phone  In a cab. Screenshot of a restaurant → filed to Goa trip › Food. 👍
16:30  bar    "remind Rohan about the advance" → draft in Hinglish → tap Send
17:45  call   Twin calls the clinic, moves dad's appointment to Thursday, transcript filed
              → nudge: "Moved to Thu 11am. Added to calendar, told Ma."
19:00  phone  Dinner with Rohan. Talking points ready: his marathon, the villa advance
21:10  mac    Merged card: "Goa trip: villa booked ✓ · Karan paid ✓ · check-in set Dec 16"
23:30  mac    Fare alert on the watched route, ₹1,100 down. Card shows, auto-closes in 60 s.
              No quiet hours: a card costs a glance, and the fare may be gone by morning.
```

Eleven cards on a busy day, in the 5–12 band of §14.5. Each auto-closes in 60 s and each is one click away in the panel afterwards.

* * *
## 4. User stories
Each story: context, goal, what the twin did, where it showed up.

1. **First space.** I pair WhatsApp. Within 2 minutes the Goa gang chat, three Airbnb visits and a Goibibo screen become a proposed space, "Goa trip with Rohan in December", under Needs you on Home, with dates, people and a first task. One tap approves it and the sweep pulls in the rest (§11.10).
  
2. **Grounded answer.** I ask "what did we decide about Goa?" in the bar. I get: dates 18–21 Dec, budget ₹6k/night, Rohan sharing flights. Each line has a quote and a tap to the message.
  
3. **Comparison ready.** I open Airbnb and look at three Anjuna villas for 4 minutes. The twin knows the space, the dates, the budget and that four people are going. It compares six villas across Airbnb, Booking and a villa site. A nudge on my Mac shows a table: price, pool, beds, distance to Anjuna, cancellation. Best fit marked.
  
4. **One tap payment.** The villa task fills the booking up to payment. An approval card shows exactly what will be charged, to whom, with cancellation terms. I tap. The payment page opens in the SuperTwin browser. I confirm there.
  
5. **Correction.** A task "collect ₹5k from Karan" appears. I say "this is Karan's task, not mine." It moves to Karan and becomes a follow-up for me. Undo chip shown.
  
6. **Pause.** From the menu bar I pause capture for 2 hours. The icon goes grey. Nothing is read.
  
7. **Forget.** I click "forget last 10 minutes". A preview shows 14 events, 1 episode. I confirm. Gone, with cascade.
  
8. **Shared trip.** I share the Goa space with Rohan, Tanvi and Karan. Karan has no SuperTwin ID. He gets an invite link. Each twin now holds its owner's tasks. Everyone sees goal, plan, tasks and results. Evidence from the group chat is visible. My DMs are not.
  
9. **Twin dinner.** I say "dinner with Rohan this weekend". My twin checks my calendar, location and food preferences. It asks Rohan's twin. They settle Saturday 8 pm at Toit. I get one card. I confirm. A cab is booked for 7:15 pm and talking points are ready at 7.
  
10. **Public list.** I make "Goa recommendations" public. A friend follows it. It seeds her Goa trip. A stranger asks my twin "good for a family of 5?". It answers from the list only.
  
11. **Message myself.** On a train I forward a villa listing to my own WhatsApp self-chat. The twin replies 👍 and files it. I say "book it". It replies with the price and a link to approve in the app.
  
12. **Support call.** My broadband is down. The twin calls the provider, waits on hold, reports the ticket number and the visit time. The call transcript is on the timeline.
  
13. **Birthday plan.** Ma's birthday is in 14 days. The twin starts a space: dinner reservation options, cake, three gift ideas from her claims, a photo collage draft. It asks once about budget. Everything else is ready to approve.
  
14. **Trace.** I open any task and see every model call, what it saw, what it said, what it cost.
  

* * *
## 5. Messaging
1. **Tagline:** _A second you. Always on. Always yours._ Alternates: _The you that never forgets and never stops._ / _Live your life. Your twin handles the rest._
  
2. **One-liner:** SuperTwin is a private AI twin that observes you and remembers everything about you, finds what needs doing now and in advance, and does it personalised to you before you ask.
  
3. **Three promises:**
  
4. **Private.** Your data stays on your devices.
  
5. **Proactive.** It does the work before you ask.
  
6. **Present.** It is on your Mac, your phone, your chats, and with you everywhere.
  
7. **Never say:** chatbot, assistant app, productivity tool, AI feed.
  
8. **Always say:** twin, remembers, prepared, your voice, your call.
  

* * *
## 6. Success metrics
North star: **hours handed back per user per day.**

| Area | Metric | Target |
| --- | --- | --- |
| Value | Tasks done per day, per user | ≥ 10 |
| Value | Transactional tasks done per day | ≥ 2 |
| Value | Value of transactions handled per day | tracked, rising |
| Value | Estimated time saved per day | ≥ 60 min |
| Activation | First useful space (proposed or created) on screen after first connect | ≤ 2 min |
| Coverage | Events filed into an episode or marked no-signal | 100% (≥ 95% into episodes) |
| Freshness, hot | Event touching open state, to understood | median ≤ 60 s |
| Freshness, cold | Every other event, to understood | ≤ 10 min |
| Task quality | Surfaced tasks the user keeps | > 90% |
| Nudge precision | Nudges that named the right goal | > 95% |
| Nudge value | Nudges opened or acted on | > 40% |
| Nudge harm | Kinds blocked by "don't do this", per user | < 1 |
| Grounding | Answers about user data that carry citations | 100% |
| Grounding | Answers whose evidence passed the sufficiency check | > 90% |
| Grounding | Bar questions escalating to agentic retrieval (§23.4) | watched, not targeted |
| Trust | Approvals granted without edit | > 90% |
| Corrections | Corrections per 100 items | < 1% |
| Safety | Gated steps without approval token | 0   |
| Cost | Steady-state model spend per month | ≤ $115 API-equivalent (§11.3); flat on a CLI subscription |
| Retention | Users active daily after 30 days | ≥ 60% |
| Together | Twin-to-twin threads settled without human chat | > 90% |
| Public | Public questions answered without owner | > 90% |

An **episode** is one burst of activity about one thing in one stream (§11.3). Every event lands somewhere: an episode, or an explicit no-signal mark (a typo, a sticker, an "ok" that closed nothing). Nothing is silently dropped.

Nudge value is deliberately not a high bar. Many cards are good news that needs no click ("check-in done"), and a glance is the correct response. Precision is the metric that matters: a card naming the wrong goal is the only failure that would make the user stop reading cards at all.

* * *
## 7. Product map and UX map
### 7.1 Product map
```
 ┌─────────────────────────────── SURFACES ────────────────────────────────┐
 │  Mac overlay · Menu bar · Nudges · Mobile · WhatsApp/iMessage/Mail ·    │
 │  Calls · Portable device · Home / cloud server · Public spaces          │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                     │  surface router picks where (§14.3)
 ┌───────────────────────────────────▼─────────────────────────────────────┐
 │  GROUNDED BAR  search · chat · new task · new space · tell the twin     │
 └───────────────────────────────────┬─────────────────────────────────────┘
                                     │
                    ┌────────────────▼─────────────────┐
                    │           WORLD MODEL            │
                    │ profile · CRM · spaces · tasks · │
                    │ calendar · claims · memory kinds │
                    └───▲──────────────────────────▲───┘
                        │                          │
     ┌──────────────────┴───────┐        ┌─────────┴──────────────────┐
     │      UNDERSTANDING       │        │        EXECUTION           │
     │ bundle · orient · critic │───────►│ space loop · task loop ·   │
     │ extract · decide         │ tasks  │ scheduler · tools · hands  │
     └──────────────▲───────────┘        └──────────────┬─────────────┘
                    │                                   │ acts in the world
 ┌──────────────────┴───────────────────────────────────▼────────────────┐
 │  EVENT LOG   append-only · local · searchable · every action is event │
 └──────────────────▲────────────────────────────────────────────────────┘
                    │
 ┌──────────────────┴────────────────────────────────────────────────────┐
 │  CAPTURE   connectors · browser · computer · inputs     [ FILTER ]    │
 └──────────────────▲────────────────────────────────────────────────────┘
                    │
 ┌──────────────────┴────────────────────────────────────────────────────┐
 │  AI CONNECTOR   CLI adapter (P1) · OAuth · OpenRouter · local models  │
 └───────────────────────────────────────────────────────────────────────┘
```

There is one path: capture → log → understanding → world model → execution → surfaces. Proactive assist is not a second path. It is this path running fast on live data (§14).
### 7.2 UX map
```
 SuperTwin
 ├── Menu bar icon ──► Panel: Needs you · Prepared · Today · pause · forget · ask
 │                     └── Nudge card (top-right, one at a time)
 ├── Overlay window (full screen, summon hotkey)
 │   ├── Home ─────── Needs you · Prepared · Spaces · Today · Recent understanding
 │   ├── Spaces ───── list by life area ──► Space view ──► Task · Milestone · Artifact · Evidence
 │   ├── Tasks ────── prioritized list (Needs you · Today · Week · Later · Waiting)
 │   ├── Calendar ─── month · week · day · agenda · layers (mine · twin · people)
 │   ├── People ───── circles ──► Person card ──► claims · tone · loops · shared spaces
 │   ├── Timeline ─── every event, every twin action, filters, day scrubber
 │   ├── Library ──── per source: capture status · windows · pause · delete · + connect
 │   ├── Scratchpad ─ everything the user pushed in: clips · shots · voice · notes
 │   ├── Browser ──── SuperTwin browser tabs · logins · agent sessions · replays
 │   ├── Public ───── my public spaces · followers · public conversations
 │   └── Settings ─── General · Capture & Privacy · Sources · AI Connector · Intelligence · Retrieval
 │                    · Enrichment · Assist · Calendar · Sharing · Public · Economy · Runs · Data
 ├── Grounded bar (inside the overlay and floating over the desktop)
 ├── Mobile app ───── Today · Needs you · Tasks · Spaces · People · Calendar · Chat · Scratchpad
 ├── Chat channels ── WhatsApp self-chat · iMessage · Mail (twin replies inline)
 ├── Calls ────────── outbound · inbound screening · transcripts
 └── Public spaces ── space page · follow · ask the twin
```

* * *
## 8. Onboarding
Goal: something useful on screen within 2 minutes of the first connect.

```
 Install → Connect AI → Connect sources → Per source: pair · count · pick windows
   30 s      10 s          20 s                    30–60 s each
        → First episodes and a first proposed space stream in → menu bar lives
                          ~2 min
```
### 8.1 Connect AI
1. Detects the installed Claude Code CLI and its login. If logged in, shows "Connected as …". No new login.
  
2. P1 ships this door only. OAuth and OpenRouter doors arrive in P3 (§9).
  
### 8.2 Sources, history, permission
1. Source grid. Each tile says: what it captures, what it never captures, what it costs. P1 tiles: WhatsApp, Browser, Screen.
  
2. Connecting is the consent to read. WhatsApp: QR pairing. Browser: read the history files. Screen: the Accessibility permission, then an explicit "record from now on".
  
3. After connecting, the twin counts what exists. Counts are real, from the source. Then the user picks two windows:
  
4. **Index.** Kept and searchable. Default: everything. Costs disk only.
  
5. **Understand.** Sent to the model. Default: last 30 days. Costs model calls.
  
6. The window card shows events (exact), and cost, time and disk (about). Nothing is sent to a model before this card is confirmed.
  
7. History runs newest first, one day at a time. Results stream in as they land.
  
8. macOS permissions are asked in context, one at a time, with a reason.
  
9. Any source can be skipped. Sources stay one click away forever: Library › "+ connect a source" and Home shows an empty-source tile until at least three are connected.
  
### 8.3 Identity
1. Onboarding collects nothing but what the sources already give: the user's name and number from WhatsApp pairing, the browser profile name.
  
2. The **"Who I am"** card is built by processing, not by onboarding. It fills over the first hour: name, city, work, key people, active goals, language mix, tone, emoji habits. The user edits any line. No confirmation step.
  
3. A **SuperTwin ID** (P4) is a keypair the app generates on the device plus a handle. The private key never leaves the device. It signs approvals and twin messages so another twin can verify "this really came from Aditya's twin" and nobody can forge it. It is not data encryption.
  
### 8.4 Login
1. **Solo mode needs no account.** No email, no password, no server.
  
2. SuperTwin ID is optional. Needed for Together and Public modes.
  

* * *
## 9. AI Connector
The twin's brain is whichever model the user already pays for, plus local models where the device allows.

```
   P1              P3              P3              P1 (small LLM: P3)
 ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
 │ CLI adapter│  │   OAuth    │  │ OpenRouter │  │   Local    │
 │ Claude Code│  │ anthropic ·│  │ any model  │  │ Embedding- │
 │ (codex,    │  │ openai ·   │  │ one key    │  │ Gemma 300M │
 │  gemini,   │  │ google     │  │            │  │ reranker · │
 │  grok: P3) │  │            │  │            │  │ whisper ·  │
 │            │  │            │  │            │  │ small LLM  │
 └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
       └───────────────┴───────────────┴───────────────┘
                               ▼
                  ┌────────────────────────┐
                  │  ONE CONTRACT          │
                  │  prompt in · JSON out  │
                  │  budget · trace        │
                  └────────────────────────┘
```
### 9.1 CLI adapter
1. Uses the user's installed CLI and subscription. P1: Claude Code only. Codex, Gemini CLI, Grok later.
  
2. Contract: prompt on stdin, JSON out, per-call budget, trace out. No tools for pipeline passes. Tools as MCP servers for agents.
  
3. Connector names and user data never leave the machine except inside the prompt itself.
  
### 9.2 OAuth
1. Sign in to a provider directly. Token stays in Keychain.
  
2. Used when no CLI is installed, or on mobile.
  
### 9.3 OpenRouter key
1. Paste one key. Any model, any provider. For cheap fast models, open models, or a specific provider.
  
### 9.4 Local models
1. Always local: embeddings, reranker, whisper, redaction.
  
2. **Default embedding model: EmbeddingGemma 300M**, 768-d, on device (§23.4). It is downloaded on first run. Until it lands, a small bundled encoder covers search, and the index is re-embedded in the background once the default arrives. An explicit pick in Settings › Intelligence is never overruled. Any swap re-embeds beside the live index and flips in one transaction, so no question is ever answered from a half-built index.
  
3. Optional local LLM for fast passes when the device can run it. Heavy passes still go to the cloud door.
  
### 9.5 Model per step
Every model and agent step has its own model picker, reasoning level and on/off switch. A step turned off queues, never drops. Recommended model shown next to each picker. Any change runs the golden set first.

| Group | Steps |
| --- | --- |
| Understanding | orient, critic, extract, decide, digest |
| Live | live orient+decide, executor-lite |
| Agents | executor, grounded bar (route, answer), twin-to-twin, public twin, call agent |
| Utility | digest lines, tiering, media description, surface router, retrieval judge |
| Local | embedding model (default EmbeddingGemma 300M), reranker, whisper model |
### 9.6 Spend
1. Ceilings are settings: per call, per hour, per day. Breach pauses background work and asks. The grounded bar keeps working; only background work pauses.
  
2. "Stop all model activity" switch. Persists across restart.
  
3. Fallback ladder across doors. A failed door shows a banner, never silence.
  

* * *
## 10. Data ingest and storage
### 10.1 Sources
Free methods only. Official APIs, exports, open protocols (whatsmeow for WhatsApp), local files and databases, and the SuperTwin browser. No paid APIs. No private-API scraping libraries on real accounts.

| Group | Sources | How | Phase |
| --- | --- | --- | --- |
| Messages | WhatsApp | whatsmeow daemon, QR pairing, history + live, token-gated send | P1  |
| Messages | iMessage, SMS | local Messages database (Full Disk); send via the Messages app through the computer hand | P2 (read), P3 (send, with the computer hand) |
| Messages | Slack, Instagram DMs, X DMs | export + SuperTwin browser | P3  |
| Mail | Gmail, other IMAP | Gmail API or IMAP, labels, threads | P2  |
| Notes | Apple Notes, Google Keep, Notion, others | local DB / API / export | P2  |
| Tasks & time | Apple Reminders, Google Tasks, Google Calendar, Apple Calendar, others | EventKit / API | P2  |
| Docs | Google Drive, Docs, Sheets, Slides | Drive API, change feed | P2  |
| Web | Browser history, bookmarks, open tabs, page text | local history DBs of every installed browser, every profile | P1  |
| Social | Instagram saves, posts, stories, reels · X bookmarks, posts · YouTube history, saved · TikTok bookmarks, posts | export first, then SuperTwin browser at human cadence | P3  |
| Screen | 24x7 accessibility tree of the front window, screenshots for AX-poor apps, system audio | screen recorder daemon | P1 (AX), P2 (screenshots, audio) |
| Meetings | Video calls, meeting transcripts | system audio + mic, local whisper, speaker separation | P2  |
| Ambient voice | 24x7 mic on Mac and on phone | local whisper, on by default with permission, one-key off | P2 (Mac), P3 (phone) |
| Mobile | Screenshots, share sheet, clipboard, location | mobile app | P3  |
| Self inputs | Scratchpad, voice input, clipboard, Mouse Helper, AI keyboard | built in | P2, keyboard P3 |
| Commerce | Amazon, Blinkit, Zomato, Swiggy, Instamart, Zepto, MakeMyTrip, Goibibo, Uber, others | order mails first, then browser order history | P3  |
| Entertainment | Netflix, Hotstar, Spotify, BookMyShow, others | export / browser history | P3  |
| AI chats | Claude (local JSONL files), ChatGPT, Gemini | file watch / export | P3  |
| Calls | Phone calls made and received through the twin | call agent transcripts | P4  |
| Self | Everything the user does inside SuperTwin | built in | P1  |

1. Each source declares: how far back it can go, live or poll, and which hand it uses.
  
2. Each source has its own Index and Understand windows. Widening a window later replays stored events. Never a re-import.
  
3. **P1 sources:** WhatsApp, browser history and bookmarks, screen via accessibility tree.
  
### 10.2 Input methods
Ways the user pushes things in. Every one produces a normal event that flows down the one path. Nothing lands in a side bucket.

1. **The grounded bar.** Typing or speaking to the twin is the richest input of all, and the only one with no ambiguity about who is speaking: first person, present tense, stated on purpose. It creates things directly (§16.1) and everything else it contains — facts, preferences, people, dates, intentions — is extracted like any other event.
  
2. **Apps.** Share sheet on Mac and phone. Share anything to the twin.
  
3. **WhatsApp and iMessage.** Message your own self-chat (§17.3). Text, voice, photo, forward.
  
4. **Clipboard.** A source like any other. Every copy is an event, after the filter. Copies from password managers and secret fields never enter.
  
5. **Screenshot.** Any screenshot is an event. It is read (OCR plus vision), filed, and shows in Scratchpad as a view.
  
6. **Voice input.** Hold a key, speak, release. Works in any app. Dictation with intent: "add milk to groceries" does it.
  
7. **Ambient voice.** Always-on mic, local transcription, speaker separation. On by default after permission. Off with one key, from the grounded bar, from the menu bar, from the phone's live activity.
  
8. **Mouse Helper.** Drag a box around anything on screen. It takes a region screenshot plus the accessibility text under it. The menu appears instantly with fixed actions: Save, Add to space…, Ask…, Copy text. No model call to show the menu. The model runs after the pick, and the result arrives as a card.
  
9. **Keyboard.** AI keyboard on phone with voice input. Suggestions and autocomplete from the twin's memory.
  

```
 ┌──────────────── Mouse Helper ────────────────┐
 │  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐            │
 │    Villa Sol · ₹5,400/night      ← dragged  │
 │    ★ 4.8 · pool · 6 beds           box      │
 │  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘            │
 │   ▸ Save          ▸ Add to space…            │  instant, no model
 │   ▸ Ask…          ▸ Copy text                │
 └──────────────────────────────────────────────┘
```
### 10.3 Three hands: connectors, browser, computer
Every source and every action uses one.

1. **Connectors.** APIs, exports, open protocols, local files and databases. First choice. Fast, safe, cheap, free.
  
2. **Browser.** The SuperTwin browser (§10.4). For sites with no API and for acting on the web.
  
3. **Computer.** Accessibility and input control of native apps. When there is no API and no web. Same rules as the browser.
  
4. Rules for browser and computer, code-enforced:
  
5. Read at human cadence. Jitter, random skips, low frequency, stop at last seen.
  
6. Never automate login, OTP or 2FA. The user logs in once, visibly.
  
7. Stop and notify on any challenge, captcha or checkpoint page.
  
8. Agent tabs and agent windows never touch the user's own tabs and windows.
  
9. Every agent session is logged step by step and can be replayed.
  
### 10.4 SuperTwin browser
One Chromium, one persistent profile, three jobs: capture of API-less sources, agent execution, and in-app webviews.

```
 ┌──────────────── SuperTwin browser ───────────────────────────────┐
 │ profile: one, persistent, logged in once                         │
 │ sessions: imported from Chrome/Safari/Arc  ·  or one-time login  │
 ├──────────────────────────────────────────────────────────────────┤
 │ EYES   distilled AX tree with stable element ids · screenshots   │
 │ HANDS  CDP: click · type · scroll · upload · download · tabs     │
 │ MEMORY per-site skills · captured network endpoints · mirrors    │
 ├──────────────────────────────────────────────────────────────────┤
 │ user tabs        agent tabs        webview cards in the app      │
 └──────────────────────────────────────────────────────────────────┘
```

1. **Engine.** Bundled Chromium, headed but hidden, driven over CDP. Never headless mode.
  
2. **Logins.** On first run the browser imports cookies, sessions, passwords and bookmarks from the user's main browsers, with permission, using Chromium's own import. Where import fails, a one-time visible login inside the SuperTwin browser. Never our own cookie decryption.
  
3. **Eyes.** Accessibility tree distilled to salient elements with stable ids. Set-of-marks screenshots as fallback.
  
4. **Hands.** A thin CDP harness exposed to the model as tools. Click, type, scroll, select, upload, download, open tab, wait.
  
5. **Memory.** Per-site skills the agent writes after the first success. Captured network endpoints: learn a site's own JSON calls once, then poll them in-page with the site's own cookies. Local mirrors with incremental cursors.
  
6. **Capture.** Reads YouTube history, X bookmarks, Instagram saves and similar in the user's own session at human cadence, incremental, stop at last seen.
  
7. **Execution.** Agent tabs run tasks: compare, fill, cart, up to the gate. The gated step runs in a webview card inside the app.
  
8. **Webviews.** Any card or answer can embed a live page from this browser. A topic started in the app continues in the same profile.
  
9. **Replay.** Every agent session stores its step log with a screenshot per step. Replay is a step-through, not a video. Optional screencast recording is off by default.
  
10. **Kill switch.** Visible. Stops every agent tab at once.
  
### 10.5 Data filter
Privacy is enforced at capture. What never enters the log never leaks.

```
  source ─► [ never-list ] ─► [ user lists ] ─► [ pause states ] ─► event log
              incognito         apps · sites       paused sources
              passwords         chats · senders    private moment
              secret fields     folders · people   forget-last-N
              banking (default) calendars
```

1. Never captured: incognito windows, password managers, secret fields, keys, banking apps by default.
  
2. User lists: apps, sites, chats, senders, folders, calendars, people.
  
3. **Private moment.** One click in the menu bar pauses everything for 15 minutes. Also a hotkey. The icon turns grey.
  
4. **Forget the last N minutes.** Menu bar. Preview, confirm, hard delete with cascade.
  
5. Per source: pause, disconnect, delete. Delete shows a preview count first.
  
6. Filters apply to index, understanding and search alike. No side channel.
  
### 10.6 Storage
1. One append-only event log in SQLite. The original payload of every event is kept as received. Long text is stored compressed on disk to save space; it reads back unchanged.
  
2. Full-text search and chunk embeddings over everything indexed.
  
3. Screen text stored as anchor plus diff.
  
4. **Two disk budgets, because media dwarfs everything else.** Measured: the event log with indexes and full-text search costs 1,330 bytes an event, about 0.5 GB a year with every P1 source on. WhatsApp media alone runs 2 MB a file, 11 files a day, about 8 GB a year — 94% of the footprint. One shared budget hides this and is spent by media inside a year. So: **events and derived data, default 2 GB a year**; **media, default 30 GB with its own retention window**, thumbnails only past 90 days. Both settings. The Library shows use per source against each.
  
5. **Not encrypted at rest in P1.** Plain files so the database and logs can be inspected and debugged. Encryption is a later option.
  
6. Sync to phone and servers is by signed, encrypted messages over the wire (§17.6). At-rest encryption on the server is a later option too.
  

* * *
## 11. Processing, organizing, understanding
### 11.1 Streams and tiers
A **stream** is where events happen: one chat, one app session, one domain on one day, one document, one mail thread. Streams are structural. They say nothing about topic.

| Tier | Streams | Processing |
| --- | --- | --- |
| 1   | DMs and groups the user has ever replied in. Everything the user actively does. | Full, live |
| 2   | Businesses the user transacts with and that send updates: orders, OTPs, bookings, bills | Full, transactional extraction, live |
| 3   | Groups and DMs the user is in but never replied to. Businesses interacted with in the past, no active relationship | Coarse digest, one week per call, only weeks with new events, later |
| 4   | Marketing and spam from businesses the user never interacted with | Index only, searchable, never understood unless promoted |

1. **Promotion.** Any engagement promotes a stream: a reply, a click, a save, a reaction. Promotion is instant and retroactive: the stream's history is re-processed at the new tier.
  
2. Tier is decided by code where possible (did the user reply), by a cheap cached model call for the business split.
  
3. Misclassification costs latency, never data.
  
### 11.2 Processing order
```
  LIVE ─────────────────────────────────────────► always first
  HISTORY  newest day ► older days
           within a day:    tier 1 ► tier 2 ► tier 3
           within a source: chats ► screen ► browser ► rest
           within a tier:   engagement × recency (an ordering signal only)
  USER PIN ─────────────────────────────────────► jumps the queue
```

1. Pin anything: a source, a chat, a sender, a mail address, a website, an app, a folder.
  
2. Old history yields the full picture, marked as history: dormant spaces, closed and probably-closed tasks, claims, patterns, relationships, life narrative. Old items are never surfaced as active or due. They make the twin know the user.
  

| Age band | Yields | Surfaced as active |
| --- | --- | --- |
| 0–30 days | everything | yes |
| 1–6 months | spaces, tasks with still-open evidence, claims, recurrences | only verified-open tasks |
| 6 months–2 years | dormant spaces, closed tasks, claims, CRM, recurrences, life events | no  |
| 2 years + | coarse claims, relationships, narrative | no  |

A recurrence detector runs across all bands. Last year's insurance renewal becomes next month's task.
### 11.3 Bundles, episodes, context
**The unit of a model call is time, not stream.** A bundle is a few minutes of life across all sources.

```
  event ──► world-model lookup (code, no model call, <100 ms)
              open task in this stream? · active episode? ·
              bridge to an active space? · entity in an active space? ·
              addressed to the twin (bar · self-chat · voice input)?
               │
               ├─ HIT (hot)   ─► FLUSH NOW, with whatever accumulated
               │
               ├─ BURST       ─► ≥4 content-new events on ONE stream within
               │                 180 s with no flush yet ─► FLUSH NOW
               │
               └─ MISS (cold) ─► accumulate
                                 flush on 300 s idle or 540 s max
             (repeated content never resets the timer and never counts)
             (30 s floor between flushes · 20k char cap forces a cut)
             (an empty accumulator never flushes: no new event, no call)
```

**Why the gate is a lookup, not a judgement.** No code rule can tell whether an "ok" matters. Character counts and intent keywords are syntactic proxies for a semantic property, and they are wrong exactly where it matters most: "ok" closing a ₹50k payment and "ok" acknowledging a joke are identical bytes. But the world model already knows whether a task is waiting in that stream, and asking it is a lookup, not a guess. That is the only thing code decides. Everything else waits for the cold window.

**Why a burst is still a lookup, not a judgement.** A single event has no readable meaning, which is why no keyword or character-count rule is allowed anywhere in this gate. A run of events on one stream is a different object. Five distinct product pages on one domain in three minutes is not a claim about what the user means. It is a count of engagement, read off the event log with no model call. That is the whole second condition.

**What the cold path costs, and why it is right.** The cold path is for topics the user is not engaging with: a single visit, a stray message, a group they never reply in, background screen churn. There is nothing to prepare, so nine minutes costs nothing. It is **not** for a new topic the user is actively working on. Browsing TVs for the first time creates no space, no task and no episode, so the state gate alone would leave it cold — and help for a purchase is worth most while the purchase is being considered, and near zero once it is made. The burst condition covers exactly that gap. It fires once per new engaged topic, the live call creates the space, and from that moment every later event in the stream is hot by the first rule.

**Bootstrapping.** A new user has no tasks, so nothing is hot and everything waits nine minutes on the day the product must prove itself. While the world model is sparse (under ~20 spaces, or the first 7 days) the cold window runs at 60 s idle / 180 s max, then widens.

1. **Is a small bundle context-starved? No.** The bundle is the delta. The call always sees the delta plus context, packed by code:
  
2. Thread history, **episode-bounded, not count-bounded**: every event of the stream's open episode, plus a short run-up before it, regardless of bundle boundaries. Quoted and replied messages are always fetched, however old. Capped at ~1,500 chars per stream and 5 streams. The number of events varies because episodes vary, which is the reason it should vary.
  
3. Open and recently dormant episodes of those streams.
  
4. Candidate spaces from retrieval, at most 5 (§23.7), with exemplar episodes.
  
5. Open tasks and the calendar for the next days.
  
6. The roster: resolved people, relationships, nicknames.
  
7. Related cross-source episodes via bridges and entities.
  
8. The current time. A bundle with one new message still sees forty messages of history and the whole state it might update.
  
9. **Thin context stops the pass.** If the packer cannot assemble enough (a stream with no history, an unresolved person, a space with no exemplars), the bundle is held for the next flush or sent with an explicit "insufficient context" instruction that permits only `unsorted` plus a question. It never permits a guess.
  
10. The packer's retrieval is **T0 only** (§23.4): local, no model call, ~150 ms. It never escalates, whatever it fails to find. That is what keeps context assembly free at ~160 bundles a day.
  
11. **Too many calls? No, because the gate spends them where state or engagement exists.** Measured on 63 days of real WhatsApp data with screen and browser modelled on top: a plain 45-second idle rule fires **474 times a day** once screen is on, because screen alone is 725 events a day. The state gate fires **147 times**, because only events touching open state jump the queue and everything else merges into a 5-minute window. Hot events still land in **43 seconds at median** — faster than the 45-second rule ever managed — at under a third of its calls. The burst condition adds roughly one call per new engaged topic, taking the day to **about 160**, still a third of the idle rule. Cost ≈ $106–115 a month API-equivalent, flat on a CLI subscription. `K=4 / W=180 s` are starting values and must be tuned against the same 63 days: too low pulls the count back toward 474.
  
12. **A day of history is split at 30k chars**, at its largest inactivity gap. That fires on 52% of days, so backfill costs about 1.55 calls per day of history, not 1. A day with no events costs nothing: it is skipped, never sent.
  
13. The model cuts a bundle into **episodes**: one burst of activity about one thing in one stream. Episodes chain across time. A flush boundary is **not** a burst boundary and never claims to be. Bursts run past it — measured p90 duration 197 s, and a 90-second cut splits two thirds of all multi-event bursts — so continuity is carried by episode `join` actions and chaining, never by where the cut fell. Batching is a cost mechanism, not a semantic one.
  
14. **Episodes and spaces.** All chained episodes about one topic file into the same space. The episode is the evidence unit inside one stream. The space is the goal across all streams. A topic that is part of a bigger goal files into that goal's space, under a milestone if there is one.
  

```
   stream wa:goa-gang      ep_412 ─ ep_530 ─ ep_611   (chained: villa talk over 3 weeks)
   stream browser:airbnb   ep_418 ─ ep_533
   stream screen:goibibo   ep_419
                              │        │        │
                              └────────┴────────┘
                                       ▼
                        SPACE  Goa trip with Rohan in December
                               └─ milestone Stay
```

15. Every episode lists its events. Every episode goes to a space or to unsorted. Unsorted is reviewed at every space birth (§11.10) and weekly.
  
16. A **critic** grades every write before commit. A wrong merge destroys. A wrong split repairs.
  
### 11.4 Memory system
Layers are storage. Kinds are what a memory means. A memory has one layer and one or more kinds.

```
  LAYERS                                    KINDS (tags on any memory)
  ┌────────────────────────────────┐        ● emotional    the feeling attached
  │ 6 WORKING   running tasks      │        ● prospective  a future intention
  ├────────────────────────────────┤        ● behavioral   changes how the twin acts
  │ 5 PROCEDURAL workflows · how-  │        ● narrative    the life arc it belongs to
  │   tos · skills · tone · habits │        ● shared       belongs to a relationship
  ├────────────────────────────────┤        ● identity     who the user is
  │ 4 IDENTITY  profile · CRM ·    │
  │   narrative                    │
  ├────────────────────────────────┤
  │ 3 SEMANTIC  claims · entities  │
  ├────────────────────────────────┤
  │ 2 EPISODIC  episodes · spaces ·│
  │   tasks · calendar             │
  ├────────────────────────────────┤
  │ 1 ARCHIVE   events · FTS ·     │
  │   embeddings                   │
  └────────────────────────────────┘
```

1. **Procedural** holds workflows (how the user does recurring things), how-tos (how to do a thing on a site or in an app, written by the twin after a success), skills, per-person tone, habits.
  
2. **Emotional.** A feeling tag on an episode or claim: joy, stress, dread, pride, annoyance. Inferred from words, reactions, timing. Used to set tone, timing and priority. "Tax filing stresses him" moves it earlier and softens the nudge.
  
3. **Prospective.** A future intention: "want to try Hampi trek", "should call the dentist". Has a horizon. Unresolved after N days (default 30, per kind) it downgrades to dormant, then to archived after 90. It wakes on any new signal.
  
4. **Behavioral.** Rules that change how the twin acts: "don't nudge on YouTube", "always Hinglish with Rohan", "ask before ordering over ₹2k". Written from feedback. Shown and editable in Settings › Assist.
  
5. **Narrative.** Life arcs: "moved to Bengaluru 2022", "building v13", "training for a marathon". Every space and many episodes belong to an arc. The narrative is the story of the user's life, not only their goals.
  
6. **Shared.** A memory that belongs to a relationship, not to either party: inside jokes, shared history, plans made together, a running tab. Held in the CRM card. In Together mode, visible to both twins only if both owners allow.
  
7. **What the user says feeds all of these, not just claims.** A goal stated in the bar is narrative, "I should call the dentist" is prospective, "stop nudging me on YouTube" is behavioral, "Tanvi's vegetarian" is semantic. One utterance can write to several layers at once (§16.1).
  
8. **Consolidation** runs on change, not on a clock: dedupe at write; merge and split over whatever was written since the last pass, checked hourly and skipped outright when nothing was; a deep pass when idle, over items touched since the last deep pass. Nothing is deleted. Old claims get an end date. Old working memory is summarized; the full log stays on disk.
  
### 11.5 People: roles, resolution, entities, circles
**Roles per message.**

```
  sender ─► audience (who can see) ⊇ receiver (who it is addressed to)
                       ⊇ mentioned receiver (named, in audience)
            mentioned third party (named, not in audience)
```

DMs: receiver = audience = one person. Mail carries sender, audience and receiver from headers. Groups need inference.

**Resolution ladder.**

1. **Structural, code, confidence 1.0.** Sender, audience from membership or headers, platform @mentions, reply and quote chains.
  
2. **Roster.** Resolved identities, relationships and nickname notes are injected into every prompt.
  
3. **Roster plus retrieval.** An unknown name pulls candidate people from the entity store: name, phone, co-mention history.
  
4. **Model.** Plain-name mentions, pronouns, receiver inference in groups. With confidence. Revisable when later evidence confirms.
  
5. **Code again.** Mentioned receiver versus third party is a set-membership test against the structural audience. Never the model's job.
  
6. **Unknown beats wrong.** Low confidence gives `unknown` plus a question. Never a guess.
  

**Entities and provisional people.**

1. Any resolved-enough mention creates a **provisional person**: name plus context anchors, no identifiers needed. A cousin, a kid, "Priya's landlord".
  
2. Provisional people merge forward when identifiers or confirmations arrive. Retrieve, then judge.
  
3. Merge and split people by drag in People. Undo always.
  

**Circles.**

| Circle | Examples | Effect |
| --- | --- | --- |
| partner |     | highest priority, longest lead times, warmest tone |
| family | parents, siblings, kids | plan ahead for dates, act on their asks |
| close friends |     | plan ahead, casual tone |
| friends |     | wish on dates, follow up on plans |
| coworkers |     | work tone, work hours |
| services | doctor, plumber, school | transactional, call-able |
| old batchmates, acquaintances |     | wish only, low nudge priority |
| business, active | user transacts, they send updates | extract orders, bills, bookings |
| business, past | transacted once, no active relationship | history only |
| business, marketing | never interacted | index only |

1. Circles are inferred from content, tone, claims and metadata. Reply volume is one weak signal. A quiet family group outranks a chatty acquaintance group.
  
2. Circles drive: processing priority, drafting tone, nudge thresholds, lead times for dates, whose tasks are the user's, and what a twin may share in Together mode.
  
3. User-editable by drag.
  

**Address and tone memory.**

1. Per person and per group: register, language mix, emoji habits, reused phrases, nicknames, sign-offs, sticker and GIF habits. Kept separately for DMs and for groups.
  
2. Address terms are classified **discriminating** (a stable unique mapping, so evidence of who is addressed) or **generic** ("bro", "boss", "yaar" used for many, so zero evidence of addressee). Generic terms feed tone, never identity.
  
3. Used for every draft the twin writes to that person or group.
  

**Applicability.**

"Everyone must submit by Friday" in a 200-member group the user never replied in is almost never the user's task. The same words in a 5-person project group are. Tier, circle and engagement ride in the prompt for exactly this.
### 11.6 Time resolution
Three clocks. Each is used for one thing.

```
  MESSAGE TIME     when it was said         → resolve relative dates ("tomorrow", "next Friday")
  PROCESSING TIME  when the twin read it    → decide if the resolved date is past or future
  VIEW TIME        when the user looks      → render "in 3 days", "2 days overdue"
```

1. Relative expressions resolve against the **message time**, stored absolute with timezone, original phrase kept.
  
2. At **processing time**: a resolved date in the past is closure-checked (did it happen?), never surfaced as due. A date in the future becomes a real due date or calendar item.
  
3. Backfill: "book by tomorrow" in a message from March resolves to a March date, is checked against later evidence, and closes or asks. It never appears as due today.
  
4. Recurring phrases ("every Friday", "monthly") become rules on the calendar, not single dates.
  
5. The **view** renders relative to now, computed at render. Nothing relative is stored.
  
6. Timezones follow the user's location at message time. Travel changes the zone; the calendar shows both when they differ.
  
### 11.7 User profile
1. Basics: name, home, hometown, addresses, contacts, social handles, birthday, anniversaries.
  
2. Life: occupation, education, partner, family, friends, coworkers.
  
3. **Narrative.** The story of the user's life: where they came from, the chapters so far, what they are doing now, where they are going. Goals sit inside it. Written by the twin, edited by the user.
  
4. Traits: claims, preferences, interests, likes, dislikes, fears, values, habits, patterns, workflows (§11.14).
  
5. Voice: tone per audience. DMs, groups, work, public, per platform.
  
6. Every line has evidence and confidence. The user edits any line.
  
### 11.8 Personal CRM
1. One card per person, including provisional people.
  
2. Card: profile fields, relationship, circle, last context, open loops, their goals and spaces, their narrative, their voice, shared memory, their public spaces if they have a twin.
  
3. **Follow-up radar.** Who owes the user a reply, who the user owes. Each with a follow-up time and a lead time for the twin to start acting. Defaults by circle, learned per person.
  
4. **Dates.** Birthdays, anniversaries, exams, flights. For each: plan or wish. Plan means a space opens at T minus lead time (default 14 days for partner and family, 7 for close friends, 0 for wish-only). Lead time and mode are per circle, per person, learned, snoozable.
  
5. Business cards carry orders, bills, bookings, tickets, support history.
  
### 11.9 Calendar
The twin builds one calendar from everything and works from it.

```
  sources ──► Google/Apple calendars · chat-derived events · booking mails · reminders ·
              tasks with due dates · twin's scheduled steps · recurrences · people's dates
                                        │
                                        ▼
  ┌──────────────────────── Calendar ─────────────────────────┐
  │ layers:  ◼ my events   ◻ my tasks   ◆ twin's tasks   ● people │
  │ views:   month · week · day · agenda                       │
  │ uses:    conflicts · travel time · lead times · quiet hours │
  └────────────────────────────────────────────────────────────┘
```

1. Every layer can be shown alone or together. "My tasks" and "twin's tasks" are separate views.
  
2. Lead-time planning: an event on the 10th opens its planning space on the 10th minus the lead time. The nudge offers snooze: next week, 10 days before, 3 days before. Snoozes are learned.
  
3. The twin schedules around the calendar: free slots, travel time by traffic, quiet hours (for when the twin acts in the world, a send or a call; never for nudges, §14.4), the user's usual times.
  
4. Chat-derived events ("dinner Sat 8pm") appear as tentative until confirmed by the user or by a booking.
  
5. Writes back to Google or Apple calendar when the user wants (per calendar setting).
  
### 11.10 Spaces
A space is one goal. It is the unit of organization and of action. It runs in a loop until the goal is met.

```
  LIFE AREA   Travel · arc "friends trips"
     └─ SPACE  Goa trip with Rohan in December     [active · one-time · ephemeral · shared 3]
          ├─ GOAL        4 people, 18–21 Dec, under ₹20k pp
          ├─ SUMMARY     dates locked, flights booked, villa shortlisted, pool payment pending
          ├─ LATEST      Rohan's twin confirmed Sat dinner · fares up 6% today
          ├─ PLAN        lock villa → pay pool → cabs → packing list → check-in
          ├─ MILESTONES  Flights ✓ ── Stay ◐ ── Day trips ○          (only if useful)
          ├─ TASKS       book villa ● executing · collect advance · web check-in ⏰ Dec 16
          ├─ FOLLOW-UPS  cab from home Dec 18 05:30 · remind Karan Sep 1
          ├─ PEOPLE      Rohan · Tanvi · Karan
          ├─ CLAIMS      budget ₹6k/night · Rohan prefers aisle
          ├─ ENRICHMENT  fares · villa availability · weather · events in Goa that weekend
          └─ EVIDENCE    episodes from WhatsApp · browser · screen · mail
```

**The space loop.**

```
   ┌──────────────────────────────────────────────────────────────┐
   │  new signal ─► update summary + latest ─► replan ─► tasks    │
   │       ▲                                              │       │
   │       │                                              ▼       │
   │  follow-ups ◄─── outcomes ◄─── execute (auto) / gate (tap)   │
   │       │                                                      │
   │       └──── goal met? no ─► wait for signal or schedule ──┘  │
   │                        yes ─► close · learn · archive         │
   └──────────────────────────────────────────────────────────────┘
```

1. Life areas: Work, Health, Money, Admin, People, Home, Travel, Shopping, Content, Learning, Hobbies, Events, Community, Safety. Editable.
  
2. Goals are **inferred** from intent, money, dates and repetition. The user edits the label and the goal.
  
3. Space properties:
  

| Property | Values | Behaviour |
| --- | --- | --- |
| State | active, dormant | Dormant wakes on new signal, schedule or user ask |
| Horizon | short-term, long-term | Drives brief cadence and nudge patience |
| Life | permanent, ephemeral | Ephemeral archives after its date |
| Cycle | one-time, recurring | Recurring spawns a fresh cycle each period |
| Access | private, shared with named people, circle, public | See §18, §19 |
| Players | solo, collaborative | Collaborative has owners across users |

4. **Space types are open-ended.** Trip, purchase, event, health, subscription, project, relationship, learning, admin, routine, finance, home, claim, move, hire, launch, and anything else the twin infers. A type carries no template. The plan is written for this user, from this user's history and habits.
  
5. **Enrichment** pulls whatever helps the goal or the plan: web data (prices, availability, hours, weather, news, reviews) and user data (past trips, past orders, related people, related spaces). Refreshes are fetches, compared by content hash in code; the model sees an enrichment only when it changed.
  
6. Cross-source joins happen in the space. A chat, a page, a screen and a mail about one trip meet here.
  
7. Milestones exist only when the goal has stages. A one-shot space has none.
  
8. Try lists and bucket lists are prospective memories that seed dormant spaces. They wake on a signal (a long weekend, a friend's plan, a price drop).
  

**Space birth.** A space is born three ways, and only one of them is ever proposed.

```
  INFERRED   Decide sees goal evidence ─► propose-only mode? ─ yes ─► review queue ─► user approves
             (intent · money · dates ·                       └─ no ──► created, announced
              repetition across ≥2 sources)
  ASKED FOR  user says it in the bar ─────────────────────► created instantly, never proposed
  WOKEN      dormant space or prospective seed gets a signal ─► reactivated with its old evidence
                                                  │
                                                  ▼
                                          THE SWEEP (all three)
```

1. **Propose-only mode** is the default for the first weeks: the twin proposes, the user approves in the review queue. It graduates to auto-create after two clean weeks on the gates — no false merges, no over-creation. Settings › General, `space creation (propose, auto)`.
  
2. **A space the user asked for is never proposed.** They just said it; asking "shall I create this?" is a worse product. It is created, swept and shown. This holds even in propose-only mode, which governs inference, not instruction.
  
3. **The sweep** runs at every birth: retrieval over unsorted and the log pulls related past episodes into the new space, including the message or utterance that justified creating it. A proposal card shows the sweep as a preview ("will pull in 3 related items") before the user approves; a user-created space sweeps immediately and reports what it found.
  
4. **Birth is deduped.** A candidate that near-matches a live space becomes an attach, or a merge question when it is close but not clearly the same. Never a second space with the same goal. The critic gates this like any other write, and it is the one check that runs even on user-created spaces — "plan a Goa trip" when Goa trip already exists asks rather than duplicates.
  
5. **Unsorted is not a grave.** Episodes with no space wait there, are re-reviewed at every birth and weekly when anything new has landed there (an unchanged unsorted is not re-read), and archive after 30 days — still searchable, still sweepable when a space is finally born.
  
### 11.11 Space list and view
1. **List.** Grouped by life area or by arc. Sort by activity, deadline, or pin. Dormant collapsed.
  
2. Row: label, area, summary line, next action, task count, freshness, people chips.
  
3. **View.** Goal, summary, latest at top. Plan. Milestone rail if any. Tasks. Prepared artifacts. Enrichment. People. Evidence timeline.
  
4. Every element opens a "why" panel: evidence quotes, confidence, trace.
  
5. Drag an episode or task to another space to correct filing.
  
### 11.12 Tasks
1. **Explicit.** The user or someone else said it.
  
2. **Implicit.** Entailed by what happened. "Flights booked" entails "web check-in".
  
3. **Suggested.** From plan gaps. Marked as suggested. No cap. If the plan needs it, it exists.
  
4. Types are open-ended. Common ones: research, search, compare, message, call, follow-up, shopping, booking, reservation, form, filing, monitoring, errand, creation, reminder, payment, return, refund, cancel, renew, schedule, post, brief. New types are allowed.
  
5. Steps depend on the task. Common ones: gather context, research, compare, draft, fill, call, book, verify, report, wait-until.
  
6. **Scheduled steps.** A step can have a run time. "Bookings open at 10 am tomorrow" becomes a wait-until step at 09:55. The scheduler wakes the task. The task is never dropped. A logically separate follow-on becomes a new scheduled task instead.
  
7. **Follow-up tasks.** When a task closes, the twin proposes and schedules the next ones. They join the plan. If the outcome changes the plan, the plan updates.
  
8. Owner is resolved from roles. Another person's task becomes a monitoring item or a follow-up for the user.
  
9. **Closure.**
  
10. Hard evidence closes: a receipt, a confirmation, both sides saying done.
  
11. One-sided intent ("paying tonight") is not closure. It makes a check at the expected time. The check is a lookup first: new evidence on the task since the last pass goes to the model; none means the "done?" card, built by code, with no call.
  
12. Past due with no evidence, or low-confidence evidence: the twin asks "done?" with one tap. Repeated silence downgrades to dormant, never deletes.
  
13. Cancellation closes as cancelled, never as done.
  
### 11.13 Prioritized task list
1. One list across all spaces. Score: deadline, gate needed, value, effort, emotional weight, waiting parties, user pins. A task for the user alone with no one waiting scores on its own merits.
  
2. Row: title, space chip, people chips, due, status, one-tap action.
  
3. Sections: **Needs you** → **Today** → **This week** → **Later** → **Waiting on others** → **Done today**.
  
4. Filter by life area, space, person, type, gate. Sort by due, score, space, recent.
  
5. The twin explains the order on hover. Reorders are learned.
  
### 11.14 Claims and traits
1. Kinds: fact, claim, belief, value, preference, interest, like, dislike, fear, opinion, recommendation, try-list item, pattern, habit, workflow, relationship, feeling. New kinds allowed.
  
2. Recommendations carry a type: place, activity, recipe, product, book, show, film, music, service, person, course, app, and more.
  
3. Patterns across time: monthly rent, Friday dinners, annual renewals, gym streaks, sleep hours.
  
4. Workflows: how the user does recurring things. The twin learns them, writes a how-to, and offers to run them.
  
5. Every claim: subject, kind, evidence quote, confidence, valid from, valid to, supersedes, superseded by.
  
6. **Typed fields** where the claim carries them: amount, currency, date, status, merchant, order id, location, duration. Extraction writes them as columns, not only as prose. This is what makes structured retrieval possible (§23.4) — a receipt stored only as the sentence "paid ₹340 to Uber" can never answer "how much on cabs last month".
  
7. **Self-reported beats inferred.** A claim from the user's own words — the bar, self-chat, voice input — carries `self_reported` provenance. Everything else is inferred from what was observed. When the two contradict, the judge supersedes the inferred claim rather than letting both stand: "she's vegetarian", typed by the user, must not tie with a two-year-old guess from one restaurant order.
  
8. Contradictions never overwrite. A judge decides: supersede (old claim gets an end date and a pointer) or coexist (both true, different contexts).
  
9. Ads are never preferences. Jokes are tone, not beliefs.
  
10. The user's recommendation lists can be shared or made public. Others can subscribe to them as their own try lists (§19).
  

* * *
## 12. Execution
```
   task ─► CONTEXT ─► PLAN ─► [ step ─► verify ]─┐ not met ─► replan (or retry if transient)
              │         │           ▲             │
              │         │           └─────────────┘
              │         │                        met
              │         │                         ▼
              │         │              gated step left?
              │         │             no ─► done ─► FOLLOW-UPS ─► plan update
              │         │             yes ─► approval card ─► tap ─► run ─► done
              ▼         ▼
        unsure or missing? ─► one combined question card ─► pause (task waits, others run)
                                                       step has a time? ─► scheduler wakes it
```
### 12.1 Context collection
1. The executor packs whatever helps: space state, plan, open tasks, claims, people, calendar, recent episodes, past attempts, how-tos, skills, and web context.
  
2. Retrieval, not enumeration. Top matches with quotes. Prompt size stays flat. The executor is the natural home of **T2 agentic retrieval** (§23.4): it already loops, reads and re-queries, so gathering context is a search loop by definition, not a single shot.
  
3. Web context when it helps: prices, availability, hours, forms, reviews, policies, anything.
  
4. **Questions.** Missing information becomes questions. There is no cap. All missing items are combined into one card with fields. Information the twin has but is unsure of is shown prefilled with "confirm?". The task pauses only for that card. Everything else keeps running.
  
5. **Thin context stops the executor.** Before acting, the executor checks that it has what the step needs: the person resolved, the date absolute, the amount known, the account identified. Anything thin becomes a question, not an assumption. An executor that acts on a guess and succeeds is still a defect.
  
### 12.2 Planning and steps
1. Plan first. Write acceptance criteria before acting.
  
2. Steps are typed but open-ended. A step can be scheduled. A step can wait on a condition (price below X, seat available, reply received) with a polling plan and a stop. A poll is a fetch and a compare in code. The model is called only when the polled value changes; an unchanged poll costs no call.
  
3. The gated step is placed last wherever the task allows. Some tasks have it earlier (a deposit before a viewing). Then the plan splits: everything before, the gate, everything after as follow-ups.
  
4. Plans are visible. Plans execute on their own. The user steers by feedback and chat on the task: "not IndiGo", "morning only". The plan changes and re-executes.
  
### 12.3 Execution with model, tools, skills, browser, computer
1. Loop: step → verify against criteria → next. On failure: retry unchanged only if the failure was transient (network, timeout, rate limit). Otherwise change the step or the plan.
  
2. The model does the reasoning and writing itself. Tools are for the world: world-model read and write, web fetch, browser, computer, files, calendar, mail, messaging, calls, connectors, and any MCP tool the user adds.
  
3. A missing tool: replan without it if the goal allows. If not, ask the user to connect it, with a one-tap link to the source tile.
  
4. **Skills: author, replay, repair, refresh.** After the first success on a site or a task type the twin **authors** a how-to: the steps it took, the stable selectors, the endpoints it learned, the waits it needed, the traps it hit. The next run **replays** that how-to with no model call at all, which is why the tenth grocery order costs nothing. When a replay breaks (a changed page, a moved button) the twin **repairs** it once with a model call, then **refreshes** the stored how-to. A skill is never thrown away and never silently re-guessed. Skills live in procedural memory (§11.4) and are visible and editable.
  
5. Browser: agent tabs in the SuperTwin browser's own profile. Never the user's browser.
  
6. Computer: native apps through accessibility. Same rules as the browser (§10.3, rule 4).
  
7. Budget per task: cycles and money. On exhaustion: best partial, the gaps, the next idea, and a one-tap "extend budget".
  
8. Gated steps are code-gated. The send and pay paths refuse without a single-use approval token minted by a tap.
  
### 12.4 The two gates
| Gated | Not gated |
| --- | --- |
| Sending a message, mail or call to a private person | Sending to a business, support, a bot, a booking form |
| Moving money: pay, transfer, subscribe, refund to a card | Carting, filling payment details up to the pay button |
|     | Posting to a public space the user marked auto-post |

1. Everything not gated runs autonomously.
  
2. **Public posts carry a soft third gate.** A post to a public space is approved one by one by default. The user removes that gate per space by marking it auto-post (§19.1). It is a default behavioral gate, not one of the two hard ones: it can be removed, they cannot.
  
3. A gate produces an approval card with exactly what will happen. One tap mints the token.
  
4. Behavioral memory can add gates ("ask before ordering over ₹2k") but never remove the two hard ones.
  
### 12.5 Channel of the gated step
The gated step runs where the action lives. Not always the browser.

| Action | Channel |
| --- | --- |
| WhatsApp send | whatsmeow daemon with token |
| iMessage send | Messages app via computer hand |
| Mail send | mail connector with token |
| Web payment | webview card in the app, user completes on the page |
| In-app payment (UPI) | phone app, user completes in the payment app |
| Call to a person | call agent dials only after the tap |
### 12.6 Working memory and scratchpad
1. Each running task has a scratchpad: findings, drafts, links, screenshots, attempt log.
  
2. The user's Scratchpad is a **view** of everything the user pushed in. Every item is already an event on the main path and is filed automatically. The view exists so the user can see what they pushed in and where it went.
  
3. Working memory is kept after completion. After 30 days it is summarized into a short record; the full log stays on disk and is searchable.
  
### 12.7 Follow-ups
1. Completion triggers a next-step pass. Follow-ups are created and scheduled. They join the plan.
  
2. Reminders, checks, monitors, cabs, thank-you notes, reviews and returns are follow-ups.
  
3. Milestones close when they exist. The next becomes active.
  
4. The outcome feeds memory. A finished trip updates preferences, people, patterns and the narrative.
  
### 12.8 Calls
Later phase (P4). The twin makes and receives phone calls on the user's behalf.

```
  outbound: task needs a call ─► script + goals ─► dial ─► talk · hold · navigate IVR ─► transcript ─► result card
  inbound:  unknown number ─► twin answers, screens, takes a message ─► user decides ─► transcript
  live:     user on a call ─► twin listens (with consent) ─► notes · reminders · "ask about X" prompts
```

1. On the phone through the mobile app. On the Mac through the connected iPhone (Continuity) when the user allows.
  
2. Calls to businesses are not gated. Calls to private people are gated like a DM.
  
3. The twin says it is calling on behalf of the user. Transcripts are events. Follow-ups come from the transcript.
  
4. The user can whisper instructions during a call from the phone screen.
  

* * *
## 13. UI surface
### 13.1 Generative UI
1. Results are typed: comparison table, itinerary, draft, approval card, question card, brief, checklist, receipt, map, calendar slot, form preview, chart, gallery, transcript, thread.
  
2. The model picks composition and content. The design system owns color, type and layout.
  
3. Every card is interactive: sort, filter, edit, approve, ask a follow-up.
  
4. When text is right, it is formatted: sections, bullets, bold for the key words, tables where they help. Never a wall.
  
### 13.2 SuperTwin browser webview
1. Any answer or card can embed a live page from the SuperTwin browser.
  
2. Web-based gated steps finish inside the embedded page. Other channels finish where they live (§12.5).
  
3. Agent sessions replay step by step, with a screenshot per step.
  

* * *
## 14. Proactive assist
### 14.1 One path, not two
Assist is not a separate lane with a separate watcher. It is the live path running end to end. Every live bundle goes through the same understanding, writes the same world model, and triggers the same executor. The difference from history processing is only speed and delivery.

Why one path:

1. **Context.** A separate watcher sees the last seconds. The live path sees thread history, spaces, tasks, claims, people, calendar and time. "He is booking a villa, the advance is due at 5 pm, Karan still owes ₹5k" needs all of it.
  
2. **One write path.** No ungated side channel into memory. No duplicate reading of the same events.
  
3. **Fewer calls.** No second model call over the same bundle.
  
4. **Consistency.** The nudge cites the same episodes the space shows.
  
### 14.2 Latency budget
```
  HOT   event ─ gate <100 ms ────────────► flush ─► pack <1 s ─► LIVE CALL 15–30 s ─┐
  BURST ≥4 content-new on one stream/180 s ─►                                        │
  COLD  300 s idle / 540 s max ────────────►                                         │
                                                    │  critic in parallel; may retract
                                                    ▼
                                         auto tasks start at once ─► executor-lite 20 s – 3 min
                                                    ▼
                                         artifact ─► surface router ─► nudge

  hot path:    43 s median to understood, ~1–4 min to a prepared artifact
  burst path:  ~3 min to understood on a topic with no state yet
  cold path:   9 min worst case, under the 10-minute promise
```

1. **Latency follows state or engagement.** An event touching an open task, an active episode or an active space is understood in well under a minute. An event on a topic the user is actively working through reaches the same call on the burst condition, before any space exists. Only events touching neither wait, because there is nothing standing by to act on them and nothing the user is doing to help with. A separate seconds-fast watcher would beat the cold path, and would see none of the context that makes the other two useful.
  
2. **Instant help** exists where the user asks: Mouse Helper, the grounded bar, voice input. Those run in seconds because the user chose the context.
  
3. History processing never nudges. Enforced twice: the history prompt has no live section, and code discards any live output outside the live lane.
  
4. The live path has reserved concurrency. History can never queue a nudge.
  
### 14.3 Surface router
Every artifact, question and approval is delivered where the user is.

```
  presence:  Mac active (screen events < 3 min) ─► nudge on Mac + panel
             phone active                       ─► phone push + app
             neither                            ─► WhatsApp self-chat (or iMessage / mail per setting)
  always:    the artifact also lands on Home › Prepared, the space, and the timeline
  gates:     approval cards go to every surface the user has enabled for approvals
```

The router decides **where**, never **whether**. There is no hold state and no quiet-hours suppression: a card the user is not there to see is routed to a surface they are, not withheld. The only reason a Mac card is not shown is that the user is not at the Mac.
### 14.4 Nudge surfaces
1. **Nudge card.** Top-right on Mac, one at a time, and the same card inside the overlay. Intent line, what I did, artifact peek, Open, Not now. **Auto-closes in 60 seconds** and has a close button, so the most a card can cost is a glance. Closing loses nothing: it is already in the panel, on the Prepared shelf, in its space and on the timeline.
  
2. **Menu bar panel.** Needs you → Prepared → Today. Capture state, pause, forget live here. The icon carries an **unread counter** for cards shown but not opened. That counter is what makes closing a card free.
  
3. **Prepared shelf.** Home, the space, the timeline. Same artifact, one status.
  
4. **Grounded bar chip.** When a fresh relevant artifact exists.
  
5. **Phone.** Push, Today list, live activity for running tasks.
  
6. **Chat channels.** A short message with a link to the card.
  
7. **Brief.** At the times set in Settings › General, one card: needs you, today, what moved since the last brief. Code composes it from the world model; a model call writes the prose only when something changed since the last brief. Nothing changed, no call, no card.
  
8. **No cap and no throttle.** Anything that helps the user or would delight them is shown. Cost is bounded by the card (item 1 above), not by a quota, so there is no daily limit, no cooldown and no quiet hours.
  
9. **Merge, don't queue.** Nudges about one space inside a short window collapse into one card: "Goa trip: villa comparison, Karan replied, fare dropped." Three helps, one glance.
  
10. **Order by decay.** When several are pending, show them in the order their value dies: help with what you're doing → needs you to finish → something moved → done for you → done in advance → understanding worth telling. Newest first inside a kind.
  
11. **Dismissals rank, they do not mute.** A dismissal lowers that kind's priority in that context. Only the user's explicit "don't do this" blocks a kind, and it is reversible in Settings › Assist. The one real quality bar is intent confidence: a card that names the wrong goal is noise, and noise is the only thing that would make the user stop reading cards.
  
### 14.5 What qualifies as a nudge
The scarce thing is not the user's tolerance for cards. A card costs a glance and auto-closes. The scarce thing is the **window in which help is worth anything**, which is why the design is speed, not gating.

```
 value of help
   │      ▲  peak: while they are doing it
   │     ╱ ╲
   │    ╱   ╲______  still useful: session over, nothing decided
   │   ╱           ╲______  low: already bought, booked, sent
   │__╱___________________╲______ time
      start    doing      decided
```

A nudge is shown when it does at least one of these six things:

1. **Helps with what the user is doing right now.**
  
2. **Did something the user was supposed to do.**
  
3. **Did something in advance of a need they have.**
  
4. **Needs the user to finish it.**
  
5. **Tells them something moved** that they were waiting on.
  
6. **Tells them a state change** they would want to know: a new space, a milestone reached.
  

Everything else is the twin's own bookkeeping and stays inside the app: claims extracted, episodes filed, a cursor advanced, a retry, a partial step of a long task, a low-confidence guess, a duplicate of something already shown. Those land on Recent understanding, in the space, and on the timeline. The boundary is **user value versus housekeeping**, not urgent versus not urgent.

**The six kinds.**

| Kind | The user gets | Examples |
| --- | --- | --- |
| **Help with what you're doing** | The next step, done, on the thing they are on | Comparison across sites for the TVs being browsed · "you saved this villa in July" · form filled on this page · cart built · draft reply for the chat being read · "you already bought this in March" |
| **Done for you** | A task they were supposed to do, finished | Check-in done · cab booked · clinic moved to Thursday · refund filed · weekly groceries carted · bill prepared |
| **Done in advance** | Work started before it was needed | Ma's birthday plan started · dormant Hampi space woke for the long weekend · fare dropped on a watched route · "dinner at 8, cab at 7:15" |
| **Needs you to finish** | The one tap or the one answer | Pay ₹8,400 · send this to Ma · "AC or sleeper?" · login expired on Goibibo · challenge page · budget exhausted |
| **Something moved** | News they were waiting on | Rohan's twin agreed Sat 8pm · Karan replied about the advance · Tanvi joined the shared trip · "you owe Sameer a reply", with the draft |
| **Understanding worth telling** | A state change they would want to know | New space started · milestone reached · "flights booked, marking done" |

**Timing is the design parameter, not permission.** For help-with-what-you're-doing the number that matters is time to card, which is why a new topic the user is engaging with must hit the burst condition (§11.3) and not the cold window. Nine minutes is longer than many buying sessions. For done-for-you and done-in-advance there is no timing question at all: show it the moment it finishes, because that is the delight and delaying it wastes it.

**Expected volume.** About 160 live calls a day (§11.3), of which 20–30 produce something the user could see, of which **5–12 earn a card**. The rest fills Prepared, the spaces and the brief.

* * *
## 15. Feedback and learning
```
  edit · drag · dismiss · approve · snooze · "tell the twin" · task chat
        │
        ▼
  correction event ─► world model update (now) ─► behavioral memory ─► golden eval case (later)
        │
        ▼
  effects: filing hints · task thresholds · nudge ranking · tone · lead times · surface choice
```

1. **Direct manipulation is correction.** Edit a title, drag a task, move a person. Undo chip. No dialogs.
  
2. One menu everywhere: Edit, Remove, Tell the twin.
  
3. **Tell the twin** locks the chat to the object. "This is Karan's, not mine." Applied at once, shown, undoable.
  
4. Quick chips per type: Not mine, Already done, Not true, Outdated, Merge into, Don't do this again.
  
5. Signal weights: explicit feedback > edits > dismissals > views. Artifact use: edited > opened > glanced.
  
6. Every correction drafts a golden eval case. No prompt ships that scores worse.
  
7. Task outcomes feed memory. Follow-up chat on a task changes the plan and re-executes.
  

* * *
## 16. Grounded bar, personality, reactions
### 16.1 One bar
1. One input. No modes. The bar understands the input and starts doing what needs to happen.
  
2. **Search.** Instant results while typing. Events, episodes, spaces, tasks, people, claims, artifacts.
  
3. **Chat.** Questions about the user's data are answered from the data, with citations. Tap a citation to land on the event. General questions are answered by the model directly, marked "not from your data".
  
4. **Action.** "Remind Rohan about the advance" becomes a task with normal gates. "Plan Hampi trek in October" creates a space and sweeps related history in. Progress shows inline.
  
5. **Correction.** Context-locked when opened from "Tell the twin".
  
6. Lives inside the overlay and floats over the desktop. Threads are events: searchable, resumable.
  

**How grounding works.** Search and chat both run the retrieval ladder (§23.4). The bar is where it is visible.

```
 keystroke ─► T0 local · no model · <150 ms ─────────────────► live list
      │ Enter
      ▼
 ROUTE   one fast call → { class: lookup | aggregate | temporal | relational |
         multihop | absence | general · methods · entities · time · filters ·
         completeness: topk | exhaustive }
      ▼
 EXECUTE named methods in parallel → RRF fuse → cross-encoder → judge
      ▼
 SUFFICIENT?  quote covers the claim · set complete · every hop resolved
      ├─ yes ─────► answer with citations
      ├─ no ──────► T2 agentic loop, budgeted, progress streamed
      └─ general ─► model answers directly, labelled "not from your data"
```

1. **Type-ahead is free.** Local only, no model call, under 150 ms: lexical prefix, vector over the partial query, and a prefix match on space, person and task names. This is the search experience.
  
2. **One call routes and plans.** On Enter, a fast call returns the question class and the retrieval plan together: which methods, which entities, which time range, which filters, and whether the answer needs top-k or an exhaustive scan. Code executes the plan; the model does not run the search.
  
3. **Sufficiency is checked in code**, not asked of the model. A lookup needs a quote that covers the claim. An aggregate needs a complete set, not a truncated one. An absence claim needs the whole thread scanned. A multi-hop question needs every hop resolved. Failing the check escalates rather than answering thinly.
  
4. **Partial answers say they are partial.** "Three so far — I only have WhatsApp back to Jan 2024" beats a confident answer off a truncated top-30. The coverage index (§23.4) is what makes the caveat truthful.
  
5. Escalation streams its progress: "looking through the Goa chat…", not a spinner.
  

**What the bar creates.** Talking to the twin is an input method (§10.2), and the richest one: first person, present tense, said on purpose. Two things happen to every submission.

```
  "plan hampi trek in october, tanvi's coming, budget 15k, she's vegetarian"
        │
        ├─ NAMED THING ─► created now, shown now
        │                 space "Hampi trek Oct" · swept 4 related items ✓
        │                 evidence = this sentence
        │
        └─ EVERYTHING ELSE ─► the normal live path, within a minute or two
                              person link  Tanvi → this space
                              claim        budget ₹15k          (self-reported)
                              claim        Tanvi is vegetarian  (self-reported)
                              prospective  Hampi trek → now active, was a try-list seed
```

1. **What it can create:** space, task, claim, person, calendar event, reminder, follow-up, try-list item, behavioral rule ("stop nudging me on YouTube"), and corrections to any of them.
  
2. **The named thing is immediate.** The user is waiting and has just been unambiguous, so the twin creates and shows rather than asking — "do, then show" (§0.3). Ambiguity in a _question_ defaults to search, which is cheap and revisable; ambiguity in an _instruction_ asks one question and holds.
  
3. **Everything else is deferred, not dropped.** The rest of the utterance flows through the ordinary live path, so it gets the packer, the critic, evidence and dedupe against what is already known. **The bar has no private write path.** The bar's stream is hot by definition (the user is addressing the twin, §11.3), so the rest lands within a minute or two through the same path as a claim from anywhere else.
  
4. **The utterance is the evidence.** A space born from "plan Hampi trek in October" cites that sentence, and "why?" on it opens the bar thread on the timeline — the same as any claim citing a WhatsApp message. Threads are events: searchable, on the timeline, feeding the learning loop.
  
5. **Follow-ups stay on the object.** "Actually make it November" updates that space; it never creates a second one. The thread locks to what it just made, the way "Tell the twin" locks to an object (§15), and unlocks on Esc.
  
6. **A faster front door, never a side door.** Anything the bar starts is a normal task with the normal gates (§12.4) and the normal critic. Speed comes from skipping the _inference_, never from skipping the _checks_.
  
### 16.2 Personality
1. Warm, brief, direct. Speaks the user's language mix.
  
2. Shows its reasoning in one line. Never lectures.
  
3. Admits gaps. "Nothing in your data about this. Here is what I know in general."
  
4. Adapts register to the surface: terse in the menu bar, fuller in the space view, casual on WhatsApp.
  
5. Has opinions when asked, built from the user's own preferences and claims. "I'd pick Villa Sol: pool, under your budget, Rohan wanted a pool."
  
### 16.3 Reactions, emoji, stickers, GIFs
Applies in two places: the twin's replies to the user on chat channels, and drafts the twin writes for the user to send to others.

1. When a reaction is enough, react. 👍 to "done". ✅ to an approval. 🎉 to a booked trip.
  
2. Emoji and stickers are valid replies on chat channels.
  
3. In drafts for other people, GIFs and stickers match the user's own habits with that person or group, from tone memory.
  
4. Text and reaction together are fine. Never a paragraph where a 👍 would do.
  

* * *
## 17. Apps surface and devices
```
                    ┌──────────────────────────┐
                    │  HOME SERVER  or  BYO CLOUD  │  24x7 brain · store · public twin host
                    └─────┬──────────┬───────┬─┘
                          │ signed, encrypted sync
              ┌───────────┘          │       └───────────┐
              ▼                      ▼                   ▼
        ┌──────────┐          ┌──────────┐         ┌──────────┐
        │   MAC    │          │  PHONE   │◄────────│ PORTABLE │
        │ overlay  │          │ capture  │         │ mic·cam  │
        │ menu bar │          │ approve  │         │ button   │
        │ hands    │          │ calls    │         └──────────┘
        └──────────┘          └──────────┘
              ▲                      ▲
              └── WhatsApp self-chat · iMessage · Mail ──┘
```
### 17.1 Desktop overlay and menu bar
1. Mac app, always resident. Menu bar icon shows capture and attention state.
  
2. The main window is a **full-screen overlay**. Summon hotkey brings it up over the desktop with a fade and blur. Esc dismisses. Windowed mode is a setting.
  
3. **Design.** Translucent glass over a live background. The background is a slow animated scene that reflects the time of day (sun position, sky), the weather now (rain, haze, clear), and the user's city (an iconic silhouette). Built procedurally from a sky layer, a weather particle layer and a skyline pack per city. Cities without a pack get a generic skyline. The user can pin a scene or turn it off.
  
4. Tabs: Home, Spaces, Tasks, Calendar, People, Timeline, Library, Scratchpad, Browser, Public, Settings.
  
5. Nudges show inside the overlay and outside it, same card.
  
6. Grounded bar floats inside the overlay and over the desktop.
  
### 17.2 Mobile app
1. Capture: screenshots, share sheet, voice, ambient voice, clipboard, AI keyboard with voice, location, calls.
  
2. Surface: Today, Needs you, Tasks, Spaces, People, Calendar, Chat, Scratchpad.
  
3. Approvals on the phone approve tasks running anywhere.
  
4. Live activity shows running tasks and the ambient voice state with a one-tap off.
  
5. Local store with sync to the Mac or server.
  
### 17.3 WhatsApp, iMessage, Mail
The twin uses the user's own accounts. No number belongs to us.

1. **Self-chat.** The user messages their own WhatsApp "You" chat, their own iMessage, or their own mail address. The twin, already paired to the user's account, reads and replies there. Private, no new number, no setup.
  
2. **Own second number.** Optionally the user adds a number they own (an eSIM). The twin pairs to it and answers as itself. Also used for calls.
  
3. Send a forward, a voice note, a photo, a question, or an order. It replies in the same channel with text, reactions, stickers or a link to a card.
  
4. Approvals can be answered by reply for non-gated confirmations. Gated steps still need the app's tap.
  
### 17.4 Portable AI device
1. Small, always with you: mic, camera, button. No screen needed.
  
2. Captures ambient voice and photos. Answers by voice through earbuds.
  
3. Syncs to the phone. Same memory, same twin.
  
### 17.5 Home server and bring-your-own cloud
1. **Home server.** A box at home runs the twin 24x7, holds all data, runs local models, hosts the public twin. Phone, Mac and device sync to it. The Mac can sleep.
  
2. **Bring-your-own cloud.** One-click setup on the user's own account at a cloud provider (a container image plus a setup script). The user owns the server and the data. We never host and never store user data.
  
3. **Hands stay at home.** Datacenter IPs get blocked by WhatsApp, Instagram, X and others. So capture and browser actions for those services run on the Mac or home server. The cloud server runs the brain and the store. A residential proxy is a paid option the user can add.
  
4. Optional. Solo mode works with the Mac alone.
  
### 17.6 Sync
1. Devices exchange signed, encrypted event batches. Any device can be offline. Order is by event id.
  
2. Conflicts are rare because everything is append-only. Derived state is rebuilt from events.
  

* * *
## 18. Collaboration
### 18.1 Shared and collaborative spaces and tasks
1. A space can be shared with named people or a circle. A trip, a wedding, a project, a flat, a shopping list.
  
2. People without a SuperTwin ID get an invite link. Accepting creates their ID and installs their twin. This is the growth loop.
  
3. What is shared by default: goal, summary, latest, plan, tasks, results, artifacts, enrichment.
  
4. What is never shared: evidence from private streams, claims about people outside the space, the owner's other spaces. Evidence from a stream every member is already in (the group chat) can be shown.
  
5. Tasks have owners across users. Each twin holds its owner's tasks.
  
6. Sharing is reversible. A member who leaves keeps a snapshot of what was shared until they left and gets nothing after.
  
### 18.2 Twin-to-twin communication
```
  Aditya's twin                                   Rohan's twin
       │  "dinner this weekend? when, where, budget?"   │
       │ ─────────────────────────────────────────────►│  free-busy · location · food · budget · mood
       │◄───────────────────────────────────────────── │  "Sat 8pm · ≤₹1.5k pp · no seafood · near Indiranagar"
       │  3 places that fit both, travel times          │
       │ ─────────────────────────────────────────────►│
       │◄───────────────────────────────────────────── │  "Toit works"
       ▼                                                ▼
   card: "Sat 8pm Toit. Rohan's twin agreed."      card to Rohan
   [Confirm] [Change]                              [Confirm] [Change]
       ▼ both confirm
   reservation · cab 7:15 · reminder · talking points: his marathon, the advance
```

1. Twins discuss and negotiate: time, place, budget, split, plan, purchase, who brings what.
  
2. Each twin speaks only within scopes its owner allowed. Scopes are open-ended: free-busy, location, preferences, budget, health limits, plan, tasks, artifacts, evidence, and anything the task needs. Defaults by circle.
  
3. The result is one card per owner. Anything binding needs both to confirm.
  
4. After confirmation the twins keep working: booking, cab, reminders, preparation, talking points, what to bring, follow-up after.
  
5. Twin messages are signed events. Both sides see the log.
  
### 18.3 Relay and cost
1. A **relay** is a server that stores and forwards encrypted twin messages when the two twins are not online at the same time. It sees ciphertext only. Any relay works; the home server can be one.
  
2. Cost model: the initiating twin pays by default. Both can share. Either party can pay. The protocol carries a cost field so any arrangement works.
  

* * *
## 19. Broadcast and public
### 19.1 Access levels
```
  private ─► shared with named people ─► shared with a circle ─► public
```

1. Recommendations, try lists, research collections, reading lists, travel logs, portfolios, projects, recipe collections are the key public spaces.
  
2. Any level per space. A Goa list can be circle-only for friends and a separate reading list public.
  
3. Public and shared spaces show curated content only. Never private evidence, never private people.
  
4. The twin drafts posts and updates per platform, in that platform's tone and subjects. The user approves each, or marks a space auto-post.
  
### 19.2 Follow and subscribe
1. Anyone can follow a public space. Followers get updates in their own twin.
  
2. A followed recommendation list becomes a try list in the follower's twin. A friend's Goa list seeds your Goa trip.
  
3. Follows are consent on both sides. Blocking is one tap.
  
### 19.3 Public twin and public page
1. A public twin answers on the owner's behalf within what is public. "What does Aditya recommend in Goa?" is answered from the public list, with sources.
  
2. Per public space the owner sets what the twin may do: answer only, take requests, accept bookings or orders.
  
3. Requests that need the owner become a task for the private twin.
  
4. The owner sees every public conversation. Rate limits and blocklists apply.
  
5. The **public page** is the view of all of one user's public spaces plus "Ask my twin". It is a surface for visitors, not a product on its own. Works from a bio, a card, a mail signature.
  

* * *
## 20. Twin economy
Twins have no screen, so the twin can receive unlimited contact without the user seeing any of it. That inverts advertising and opens a task market.
### 20.1 Brand twins to user twins
```
  brand twins ──► user twin's inbox (no screen, unlimited) ──► filter by needs, claims, spaces
                                                                    │
                                                                    ▼
                                                            shortlist (0–3) ──► one card, when relevant
  payment:  per contact (small) · per shortlist (larger) · per acted-on (largest)
            ≥ 90% to the user · rest to the platform · user sets who may contact and floors
```

1. A brand twin can only send offers. It sees nothing. The user twin matches offers to real needs: an open shopping task, a claim, a space.
  
2. The user sees a card only when an offer is a real fit and only inside the space it fits.
  
3. The user controls: whether brand twins may contact at all, categories, minimum price per contact, frequency.
  
### 20.2 Task market
1. A user's twin can post a task other twins or brand twins can do, and pay for it. "Find me a plumber Saturday morning." "Book the best table for 6." Businesses' twins bid or fulfil.
  
2. A user's twin can do tasks for other twins and get paid. A local expert's recommendation list, a translation, a review.
  
3. Escrow, ratings and disputes live in the protocol. The gate still applies: the user's twin never pays without the tap.
  

* * *
## 21. UI and UX screens
Design language: glass over the live scene. One type scale. One card anatomy: header, body, evidence strip, three-item menu.
### 21.1 Onboarding
```
 ┌────────────────────────────────────────────────────────────────────┐
 │  Connect a source                                    step 2 of 3   │
 │                                                                    │
 │  ┌ WhatsApp ─────┐ ┌ Browser ──────┐ ┌ Screen ───────┐              │
 │  │ chats, media  │ │ history, tabs │ │ what you see  │              │
 │  │ never: status │ │ never: incog. │ │ never: passw. │              │
 │  │ [ Pair ]      │ │ [ Connect ]   │ │ [ Allow ]     │              │
 │  └───────────────┘ └───────────────┘ └───────────────┘              │
 │  more sources later from Library                                   │
 │                                                                    │
 │  ── WhatsApp paired ✓ · counted 38,412 messages in 214 chats ───── │
 │  Index      [ everything ▾ ]   38,412 messages · 210 MB   exact    │
 │  Understand [ 30 days ▾ ]       1,204 messages · ~30¢ · ~4 min      │
 │  Nothing goes to a model until you confirm.                        │
 │                            [ Skip for now ]   [ Confirm & start ]  │
 └────────────────────────────────────────────────────────────────────┘
```
### 21.2 Home (overlay)
```
 ┌── ⌂ Home  ▤ Spaces  ☑ Tasks  ▦ Calendar  ◙ People  ◷ Timeline  ▥ Library  ✎ Scratchpad  ⚙ ──┐
 │                                                     ▓ live scene: evening, drizzle, Bengaluru ▓ │
 │ ┌─ Needs you ───────────────────────┐  ┌─ Spaces ────────────────────────────────────────────┐  │
 │ │ ▸ Pay insurance renewal ₹8,400     │  │ ● Goa trip with Rohan · Dec   villa shortlisted · 3  │  │
 │ │ ▸ Confirm: dinner Sat 8pm Toit     │  │ ● Ma's birthday · 14 days     gifts · dinner · cake  │  │
 │ │ ▸ Q: Ma's ticket — AC or sleeper?  │  │ ● v13 launch                  4 tasks · Sameer       │  │
 │ └───────────────────────────────────┘  │ ○ Gym restart (dormant)                              │  │
 │ ┌─ Prepared for you ────────────────┐  └──────────────────────────────────────────────────────┘  │
 │ │ ◆● Villa comparison — 3 fit budget │  ┌─ Today ──────────────┐ ┌─ Recent understanding ─────┐  │
 │ │ ◇  Reply to Ma (Hindi)             │  │ 20:00 dinner · Toit  │ │ + Rohan prefers aisle seats│  │
 │ │ ◇  Clinic moved to Thu 11am        │  │ 19:15 cab booked ◆   │ │ + Trip budget ₹6k/night   │  │
 │ └───────────────────────────────────┘  └──────────────────────┘ └────────────────────────────┘  │
 │                 ┌───────────────────────────────────────────────────────┐                        │
 │                 │ ⌕  Ask, search, or tell me to do something          ↑ │  🎙 ambient on · ⏸       │
 │                 └───────────────────────────────────────────────────────┘                        │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```
### 21.3 Space view
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ Goa trip with Rohan ✎      active · one-time · Travel · shared 3    │
 │ goal     4 people, 18–21 Dec, under ₹20k pp                         │
 │ summary  dates locked · flights booked · villa shortlisted          │
 │ latest   fares up 6% · Rohan's twin confirmed Sat dinner   2 min ago│
 │                                                                    │
 │ plan     lock villa → pay pool → cabs → packing → check-in ⏰ Dec 16 │
 │ ◆ Villa comparison ready — 3 fit budget · open                     │
 │ ┌─ tasks ────────────────────────────────────────────────────────┐ │
 │ │ ▸ Book villa                       ● executing · step 3/5      │ │
 │ │ ▸ Collect ₹5k advance from Karan   Karan's · follow-up Sep 1   │ │
 │ │ ▸ Web check-in                     ⏰ Dec 16 07:00 · auto       │ │
 │ └────────────────────────────────────────────────────────────────┘ │
 │ people    Rohan · Tanvi · Karan         claims  ₹6k/night · aisle   │
 │ enrich    fares ₹4.8–5.6k · villa availability · 29°C · Sunburn wknd│
 │ evidence  ▂▃▅▂▃  WhatsApp · browser · screen · mail                │
 │                                          why? · trace · ··· share  │
 └────────────────────────────────────────────────────────────────────┘
```
### 21.4 Tasks
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ Tasks      [ area ▾ ] [ person ▾ ] [ type ▾ ] [ gate ▾ ]  sort: score ▾ │
 │ NEEDS YOU                                                          │
 │ ▸ Pay insurance renewal ₹8,400    Admin      HDFC Ergo   [ View ][✓]│
 │ ▸ Ma's ticket: AC or sleeper?     Family     Ma        [ AC ][ SL ] │
 │ TODAY                                                              │
 │ ▸ Reply to Ma                     Family     Ma        draft ready  │
 │ ▸ Dinner with Rohan 8pm           People     Rohan     cab 7:15 ◆   │
 │ THIS WEEK                                                          │
 │ ▸ Gift ideas for Ma               Family     Ma        3 ready      │
 │ ▸ Renew car insurance             Admin      —         ○ research   │
 │ WAITING ON OTHERS                                                  │
 │ ▸ Karan: villa advance            Goa trip   Karan     asked Tue    │
 │ DONE TODAY (4)                                                   ▸ │
 └────────────────────────────────────────────────────────────────────┘
```
### 21.5 Calendar
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ Calendar   [ month ] [ week ] [ day ] [ agenda ]   layers ◼ ◻ ◆ ●   │
 │ Sep 2026            Mon      Tue      Wed      Thu      Fri   Sat  │
 │ ─────────────────────────────────────────────────────────────────  │
 │ week 1         1 ◻ remind  2 ◻ Karan   3        4          5   6 ◼ │
 │                  Karan       advance                        dinner │
 │                                                          Rohan 8pm │
 │                                                          ● Ma -14d │
 │ week 2         8           9        10       11 ◆ clinic 12  13    │
 │                                                  11am              │
 │ week 3        15 ◆ gifts  16 ◆ cake 17       18         19  20 ●   │
 │                  to cart                                  MA'S     │
 │                                                          BIRTHDAY  │
 │ ─────────────────────────────────────────────────────────────────  │
 │ ● Ma's birthday Sep 20 · planning started Sep 6 (14 days before)   │
 │   [ snooze to next week ] [ 10 days before ] [ stop planning ]     │
 └────────────────────────────────────────────────────────────────────┘
```
### 21.6 Person card
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ ◙ Rohan Mehta                  ⦿ close friends · twin: @rohan ✓     │
 │ claims    prefers aisle · not vegetarian · runs Sundays · hates hold│
 │ tone      Hinglish, short, 🔥-heavy · "bhai" · "scene?" · DM only  │
 │ shared    ● Goa trip · ● Diwali gifts       shared memory: tab ₹5k │
 │ loops     Karan's villa advance (Goa) · birthday in 12 days (7d)   │
 │ follow-up reply owed since Tue · start acting Fri                  │
 │ recent    WhatsApp 2h ago · split PDF on screen, Tue               │
 │ theirs    marathon in Jan (public space) · Goa list (following)    │
 └────────────────────────────────────────────────────────────────────┘
```
### 21.7 Menu bar and nudge
```
 ┌─ SuperTwin ──────────── ③ ● rec 🎙 ⏸ ▾ ─┐   ┌─ nudge (top-right, and in-app) ───┐
 │ NEEDS YOU                                 │   │ ◆ Goa trip › Stay                 │
 │ ▸ Pay renewal ₹8,400        [view] [✓]    │   │ Saw you comparing Anjuna villas.  │
 │ ▸ Ma's ticket?           [AC] [sleeper]   │   │ Compared 6 across 3 sites.        │
 │ PREPARED                                  │   │ 3 fit ₹6k/night.                  │
 │ ◆● Villa comparison           2:41pm      │   │ ┌───────────────────────────────┐ │
 │ ◇ Reply to Ma                 9:20am      │   │ │ Villa Sol ₹5.4k ★4.8 · pool   │ │
 │ TODAY  dinner 8pm · cab 7:15 · pool 6pm   │   │ │ + 2 more                      │ │
 │ ────────────────────────────────────────  │   │ └───────────────────────────────┘ │
 │ ⌕ ask…   private moment   forget 10 min   │   │  [ Open ]  [ Not now ]  ✕   ◷ 47s │
 └───────────────────────────────────────────┘   └───────────────────────────────────┘

   ③ = cards shown but not opened. Nothing is lost by closing one.
   ◷ = auto-close countdown, 60 s. Merged card when one space has several:
       "◆ Goa trip: villa comparison · Karan replied · fare dropped"
```
### 21.8 Grounded bar
```
 ① collapsed   ┌ ⌕ Ask, search, or tell me to do something ↑ ┐
 ② typing      ┌ ⌕ goa vill▌                                 ┐
               │  ▸ 12 events · ▸ 2 episodes · ▸ Goa › Stay   │
 ③ answer      │ you: how much per night?                     │
               │ twin: ₹6k max — you, Aug 24 ¹ · Rohan ²      │
               │ ¹ ❝max 6k a night yaar❞  ² ❝under 20k pp❞    │
 ③' general    │ you: what's the GST on hotel rooms?          │
               │ twin: 12% under ₹7.5k… (not from your data)  │
 ④ acting      │ you: remind rohan about the advance          │
               │ twin: ❝bhai villa advance ₹5k…❞  ✎           │
               │ [ Send (approve) ] [ Change ] [ Cancel ]     │
 ④' creating   │ you: plan hampi trek in october, tanvi's     │
               │      coming, budget 15k, she's vegetarian    │
               │ twin: creating space → swept 4 related ✓     │
               │       ▸ Hampi trek Oct  ·  Travel            │
               │ …then, on the live path: Tanvi linked ·      │
               │    budget ₹15k · Tanvi vegetarian  (learned) │
 ⑤ locked      │ ⊙ task: Book villa  ✕                        │
               │ you: this is karan's, not mine → moved ✓ undo│
 ⑥ history     │ ▸ villa advance · ▸ hampi trek · ▸ per night │
```
### 21.9 Scratchpad and Browser tabs
```
 ┌─ Scratchpad ─────────────────────────────┐  ┌─ Browser ────────────────────────────┐
 │ 15:30 📷 restaurant shot → Goa › Food ✓   │  │ logged in: airbnb ✓ amazon ✓ x ✓ ig ✓ │
 │ 14:10 📋 "villa sol anjuna" → Goa › Stay  │  │ agent tabs (2)  Book villa · step 3   │
 │ 11:02 🎤 "call the clinic, move to thu"   │  │   ▸ replay · ▸ take over · ▸ stop     │
 │        → task ✓ done 17:45                │  │ sessions today 6 · skills 14          │
 │ 09:40 ⬚ Mouse Helper: fare table → saved  │  │ [ open a tab ]  [ connect a login ]   │
 └───────────────────────────────────────────┘  └──────────────────────────────────────┘
```
### 21.10 Mobile
```
 ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
 │ Today            │   │ Approve          │   │ 🎤 hold to talk  │
 │ ● Pay ₹8,400     │   │ Pay ₹8,400       │   │ "add milk to the │
 │ ● Ma's ticket?   │   │ HDFC Ergo · 1 yr │   │  grocery space"  │
 │ ○ Dinner 8pm ◆cab│   │ card •• 4412     │   │                  │
 │ ◆ Villa compare  │   │ criteria 5/5 ✓   │   │ ✓ added · 👍     │
 │ ─────────────    │   │ [ Approve ]      │   │ live: 🎙 on · ⏸  │
 │ ⌕ 📷 🎤 📎 ☑ ◙   │   │ [ Change ] [ ✕ ] │   │ ⌕ 📷 🎤 📎 ☑ ◙   │
 └──────────────────┘   └──────────────────┘   └──────────────────┘
```
### 21.11 WhatsApp self-chat
```
  You (to yourself):  [forwarded] "Anjuna villa ₹5.4k, pool, 6 beds"
  Twin:               👍 added to Goa trip › Stay. Cheapest of your 3.
  You:                book it
  Twin:               Ready. ₹16,200 for 3 nights, free cancel till Dec 1.
                      Tap to approve → supertwin://approve/8f2c
```
### 21.12 Public space page
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ @aditya · Goa recommendations                 Follow · Subscribe   │
 │ 14 places · updated 3 days ago · circle: public                    │
 │ ▸ Gunpowder, Assagao — "best pork vindaloo, go early"              │
 │ ▸ Villa Sol, Anjuna — "pool, 6 beds, ₹5.4k in Dec"                 │
 │ ▸ Morjim beach at sunrise                                          │
 │ ──────────────────────────────────────────────────────────────────  │
 │ Ask Aditya's twin:  ⌕ "good for a family of 5?"                     │
 └────────────────────────────────────────────────────────────────────┘
```

* * *
## 22. Architecture
```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ SURFACES    overlay · menu bar · mobile · chat channels · calls ·    │
 │             public pages                                             │
 ├──────────────────────────────────────────────────────────────────────┤
 │ SERVICES    grounded bar · surface router · space loop · executor ·  │
 │             scheduler · call agent · twin protocol · sync            │
 ├──────────────────────────────────────────────────────────────────────┤
 │ UNDERSTAND  packer · live call · orient · critic · extract · decide ·│
 │             digest · consolidation                                   │
 ├──────────────────────────────────────────────────────────────────────┤
 │ MEMORY      event log · FTS · embeddings · graph (entities · edges · │
 │             bridges) · world model · calendar · coverage index ·     │
 │             traces · public store (separate)                         │
 ├──────────────────────────────────────────────────────────────────────┤
 │ CAPTURE     adapters · filter · consent gate · SuperTwin browser ·   │
 │             computer hand                                            │
 ├──────────────────────────────────────────────────────────────────────┤
 │ BRAIN       AI connector · per-step models · local models · skills   │
 ├──────────────────────────────────────────────────────────────────────┤
 │ TRUST       consent records · approval tokens · keypair · audit log  │
 └──────────────────────────────────────────────────────────────────────┘
```

1. **One worker process** owns the log, the lanes and the services. The UI renders and emits events.
  
2. **Adapters are plugins.** One contract: enumerate, count, backfill, live, filter, act. A new source is one adapter.
  
3. **Passes are single-shot.** Prompt in, JSON out. Agents run only where work is being done or where a scheduled step has come due.
  
4. **Every model call has a trace.**
  
5. **Sync and twin traffic are message-based.** Signed, encrypted batches. No central store.
  
6. **The public store is separate.** The public twin can only read it.
  

* * *
## 23. System design
### 23.1 Event envelope
```
 event {
   id · ts · captured_at · source · kind · origin live|backfill · age_band
   stream_key · actor · roles { sender, audience[], receiver[], mentions[] }
   payload (typed) · content_hash · blob_refs[] · consent_id · tier
 }
```
### 23.2 Lanes
```
  LIVE       state gate: HOT flushes now · BURST (≥4 content-new on one stream
             within 180 s) flushes now · COLD idle 300 s / max 540 s / 20k chars · never empty
             → one call: orient + decide → executor · critic parallel, may retract
             reserved slots: history can never queue a nudge
  HISTORY    one calendar day per call, split at 30k chars, newest first, empty days skipped
             →  orient → critic → extract → decide
             never nudges · never starts executors except scheduled recurrences
  DIGEST     tier-3 streams, one week per call, only weeks with new events
             →  summary · claims · recurrences
```
### 23.3 Passes
| Pass | Unit | Output |
| --- | --- | --- |
| Live | one live bundle | episodes, filing, tasks, schedules, closures, questions, prepared actions (no cap — one bundle can warrant several) |
| Orient | one history bundle | episodes, filing, proposals, unsorted, questions |
| Critic | any write set | commit, reject, downgrade, flag |
| Extract | committed episodes | claims, people, tone, feelings |
| Decide | one space | summary, latest, plan, milestones, tasks, schedules, closures, follow-ups |
| Digest | one tier-3 stream, one week | summary, claims, recurrences |
| Route | one bar query | question class + retrieval plan (§16.1) |
| Judge | fused top-10 candidates, T1 and T2 only | 3–5 results with quotes |
| Surface router | one artifact | surface, timing |
### 23.4 Retrieval
What it is: the way every pass, the bar, the executor and the public twin find the few relevant things in a large memory without reading all of it. Measurements and the reasoning behind the tier split: `docs/retrieval-and-graph-decision.md`.

**Five methods.** Similarity answers one kind of question. Five methods run against one index.

| Method | Answers | Fails at |
| --- | --- | --- |
| Lexical (BM25) | rare tokens, names, numbers — "the message with ₹5,400" | paraphrase |
| Vector (EmbeddingGemma 300M, local, 768-d) | "the villa with a pool" when the page said "6 beds, swimming pool" | counting, absence |
| Structured (SQL over the world model) | sums, counts, date ranges, status filters, enumeration by type | anything not typed |
| Graph (§23.5) | "what does Ma care about", "who did we meet through Rohan" | starting cold — needs seeds |
| Time window | "what happened Tuesday afternoon" — a range scan, not a search | relevance |

1. No top-k of chunks is a sum, and no ranking proves an absence. Questions shaped _how much · how many · did anyone ever · list all_ route to structured or to a bounded scan, never to similarity.
  
2. Fusion is by **reciprocal rank**, not a score union. BM25 and cosine scores are not on one scale, so a naive union lets whichever scorer runs hot own the candidate pool.
  
3. The cross-encoder reranker (bge-reranker class, local) runs on the fused candidates at every tier. A judge call, one model call that re-reads the top 10 and returns 3–5 with quotes, runs at T1 and T2 only, when a pass needs precision. It never runs for the packer, which is what keeps T0 at zero model calls.
  

**Three tiers.**

```
 T0  HYBRID        lexical ∪ vector ∪ exact keys → RRF → cross-encoder
     ~150 ms · 0 model calls · local
     ▸ the packer (every bundle) · bar type-ahead · consolidation
                   │ evidence insufficient?
                   ▼
 T1  PLANNED       one fast call → retrieval plan (methods · entities · time ·
     ~1 s · 1 call    filters · completeness) → code executes → fuse → judge
     ▸ most bar questions · executor context
                   │ still insufficient?
                   ▼
 T2  AGENTIC       loop: search → read → name what is missing → search again
     5–30 s · 3–8    budget: hops · seconds · money → best-partial + gaps
     ▸ multi-hop · absence proofs · "everything about X" · contradictions
```

1. **The packer never leaves T0.** It runs on every bundle, ~160 times a day. Escalating it would multiply background calls and break both the cold window and the monthly cost target. Invariant, §23.7.
  
2. The bar and the executor escalate freely. A human is waiting, and it is a handful of escalations a day.
  
3. T2 is metered like every other loop: hops, seconds, money. On exhaustion it returns the best partial plus the named gaps, never silence (§23.7).
  

**The index.**

1. **Indexed:** event chunks (rolling 2k chars per stream), episode summaries, space cards (label, goal, summary), claims, people cards, how-tos, artifacts.
  
2. **Typed fields** ride alongside the text wherever extraction found them: amount, currency, date, status, merchant, order id, location, duration (§11.14). Structured retrieval queries these. Without them "how much did I spend on cabs last month" is unanswerable forever, however good the embeddings are.
  
3. **Coverage index:** per source, per date range, what exists and what was never captured. Knowing what is missing is what lets an answer say "three so far, and I only have WhatsApp back to Jan 2024" instead of answering confidently off a truncated list.
  
4. **Who uses it:** the packer (candidate spaces, related episodes, relevant claims, roster candidates), the grounded bar, the executor (context), consolidation (duplicates), the public twin (public store only), twin-to-twin (within scopes).
  
5. Never a full vector scan. Never writes. Cites by id.
  
### 23.5 Graph
The entity graph is `entities` + `entity_edges` + `edge_evidence` + `bridges`, in the same SQLite database as everything else. Edges are typed and weighted, carry a validity window, and cite the event that made them.

```
  seeds (from lexical + vector)        hop 1                  hop 2
   ◉ Ma ──── mother_of ─────────────► ◉ self   ✗ hub, excluded
     └────── mentioned_in ──────────► ◉ ep_882 ─ about ─────► ◉ Diwali gifts
     └────── prefers ───────────────► ◉ jasmine tea
   ◉ Rohan ─ close_friend ──────────► ◉ Tanvi  ─ in ────────► ◉ Goa trip

   score = hop decay × edge confidence × evidence recency
   superseded and expired edges skipped · fan-out capped per node
```

1. **Edges** carry `kind · subtype · src · dst · confidence · status · valid_from · valid_to`, plus evidence rows pointing at the events and the verbatim quote. Bridges (URL, phone, order id, mail thread) are the highest-precision edges: exact matches, no model. They are what joins a browser visit to a chat message to a confirmation mail.
  
2. **Traversal rules.** Seeds come from lexical and vector — the graph never starts cold. Two to three hops. Prune by `kind`, `status` and validity. Cap fan-out per node to the top edges by confidence. **Exclude hub nodes**: the user connects to everything, so a walk through `self` reaches the whole graph in two hops and returns noise.
  
3. **One store.** The graph stays in SQLite. A second datastore would split the critic-gated commit, which writes episodes, edges, claims and evidence in one transaction, and would break the queries that matter most — which are hybrid: walk from a person to their claims, filtered to tier-1 evidence from the last six months, ranked lexically against the query. That is one statement in one database, and application-level join logic across two.
  
4. **Revisit only if** edges pass ~10⁷, or variable-length path queries become a language need rather than a handful of known walks, or graphs move server-side and stop being per-device. Then an embedded engine as a projection off the event log, never as a second source of truth. Reasoning: `docs/retrieval-and-graph-decision.md`.
  
### 23.6 Scheduler
1. Holds wake-ups: scheduled steps, scheduled tasks, recurrences, lead-time planning, polls with stop conditions, follow-up checks, closure checks.
  
2. Fires into the executor with the space context. Missed wake-ups (machine asleep) fire on wake, with the delay shown.
  
3. Every wake-up is visible on the calendar in the twin layer.
  
4. **A wake-up is a lookup before it is a call.** Follow-up checks, closure checks, polls, and unsorted or consolidation sweeps first ask the world model what changed since their last pass. Nothing changed, no model call, and the wake-up is logged as a no-op. A model is called on a clock only where the clock is the work: a scheduled step, a recurrence coming due, a lead-time plan opening.
  
### 23.7 Safety invariants
1. No adapter reads before its consent record exists.
  
2. Gated actions require a single-use signed token minted by a user tap.
  
3. Spend and call ceilings throw before the model is called.
  
4. A bundle is attempted at most 3 times, then dead-lettered and shown.
  
5. Deleting a source cascades to everything derived from it.
  
6. History output never reaches a nudge surface.
  
7. The public twin reads only the public store.
  
8. Browser and computer hands stop on any challenge page and never automate login.
  
9. **A model call is never gated on a content heuristic.** The state gate reads the world model, never the text. No character count, keyword, intent regex or "low signal" rule may decide whether an event is understood. Whether an "ok" matters is a semantic question, and code answers it only by asking what state already exists.
  
10. **The packer never enumerates.** Candidate spaces come from retrieval, hard-capped at 5, whatever the space count. Measured on the prior build: enumerating all 104 spaces produced a 37,000-character prompt that grew with every space the user accumulated. The whole V6 pack is under 16,000 and flat.
  
11. **Captured content is never an instruction.** Every prompt carries captured material inside a quoted block marked as untrusted data. Instructions to the model live only in the system prompt, which no captured text can reach. Text found in a message, page, screen, document, twin message or public comment that tries to direct the twin (claiming authority, urgency, or a rule change) is surfaced to the user with its source, never acted on. A tool call whose argument came from captured text is validated against the world model before it runs.
  
12. **No write without evidence.** The commit path rejects any claim, task, space or episode whose evidence does not resolve to real event ids, and any quote that is not verbatim in those events. Fabrication is an automatic reject, not a downgrade.
  
13. **Every loop is metered.** Executor cycles, replay attempts, browser sessions, polling schedules and agentic retrieval each carry a ceiling and a trace. A loop with no ceiling cannot start.
  
14. **Retrieval never writes.** Every tier reads and cites. A retrieval path that mutates the world model is a defect, not a feature.
  
15. **The packer never escalates past T0.** Context assembly for a bundle is local and model-free, whatever it fails to find. Thin context produces a question (§11.3), never a search loop.
  
16. **No new event, no model call.** Nothing calls a model on a clock alone. The cold window is a timer on accumulated events and never fires empty. History skips empty days, digests skip empty weeks. Consolidation, unsorted review, closure checks, polls, enrichment refreshes and briefs run over what changed since their last pass and skip when nothing did. The only clock-driven calls are those where the clock is the work: a scheduled step, a recurrence coming due, a lead-time plan opening (§23.6).
  
### 23.8 Twin protocol
1. Message: `{ from_key, to_key, thread, intent, scopes[], body, cost, sig }`.
  
2. Each twin answers within granted scopes. Anything else returns "ask my owner" and becomes a task.
  
3. Transport: any relay holding ciphertext, or direct when both are online.
  

* * *
## 24. Step by step
Rohan writes "guys lets lock goa 18-21 dec" in the Goa gang group. The user then opens Airbnb.

```
  1  CAPTURE    WhatsApp adapter emits e1. Consent ok. Filter ok. Tier 1. Written to log.
  2  ARCHIVE    FTS indexed. Chunk embedded. Stream wa:goa-gang.
  3  GATE       e1's stream has an open task ("collect advance from Karan") → HOT → flush now.
                Bundle = e1 + what accumulated since the last flush: 3 Airbnb visits, 1 Airbnb
                screen. The replies that follow are hot too and ride the next bundles (30 s floor).
  4  PACK       Thread history (40 msgs), open episodes, candidate spaces (retrieval),
                open tasks, calendar, roster, bridges (airbnb URLs), time.
  5  LIVE CALL  Episode "dates locked 18–21 Dec" → space Goa trip. Task "book flights",
                schedule check-in T-48h, plan updated. Intent: comparing villas, 0.9.
                Prepared action: compare villas. Critic in parallel: commit.
  6  EXTRACT    Claims: dates 18–21 Dec. Rohan will share flight link. Feeling: excitement.
  7  EXECUTE    Executor-lite compares 6 villas across 3 sites with budget and dates. Artifact.
  8  ROUTE      Mac active → nudge card + panel + space banner + Home shelf.
  9  SPACE LOOP Summary and latest updated. Follow-up: collect advance from Karan, Sep 1.
 10  TASK       "Book flights": plan, compare, fill up to payment. Approval card.
 11  GATE       User taps. Token minted. Payment page in webview. User confirms.
 12  FOLLOW-UP  "Flights booked ✓" → web check-in scheduled Dec 16 07:00 · cab task Dec 18.
 13  CALENDAR   Trip, flights, check-in, cab appear in layers.
 14  TOGETHER   Shared with Rohan, Tanvi, Karan. Karan's twin holds "pay advance".
 15  LEARN      User renames the cab task. Correction event. Eval case drafted.
 16  MEMORY     Trip closes in December. Preferences, people, patterns, narrative updated.
```

Steps 1–8 finish within about 2 minutes of Rohan's message.

* * *
## 25. Settings
Left rail, one pane per group. Everything in the current V13 app is kept; new groups are added.

| Group | Settings |
| --- | --- |
| General | launch at login, macOS notifications, summon hotkey, bar hotkey, ambient-off hotkey, appearance (light, dark, system), overlay or windowed, live scene (on, pinned, off), brief times, space creation (propose, auto) |
| Capture & Privacy | per-source capture toggles, app and domain blocklists, chat and sender lists, folders, people, incognito policy (always off, shown), pause states, private moment, forget last N, ambient voice on/off per device, screenshot capture, system audio |
| Sources | connect flows, status, index window, understand window, watermark, last event, pins, per-source pause, disconnect, delete |
| AI Connector | doors (CLI, OAuth, OpenRouter, local), connected account, fallback order, spend ceilings (per call, hour, day), stop-all switch |
| Intelligence | model per step, reasoning per step, on/off per step, recommended model shown, embedding model (default EmbeddingGemma 300M), reranker model, semantic retrieval on/off, cost per step last 7 days |
| Retrieval | agentic retrieval in the bar (on/off), hop budget and time budget for T2, exhaustive-scan row limit, graph hop limit and fan-out cap, hub-node exclusion list |
| Enrichment | whisper model, voice notes, video audio, describe media as it arrives, history backlog, photos and stickers, video thumbnail, frame sampling (interval, max, height), media in business chats, fetch linked pages, backfill rate, concurrency |
| Assist | **freshness = the cold window**, idle / max (Live 120 / 180 s · Balanced 300 / 540 s · Relaxed 420 / 600 s; the max never exceeds 600 s, the 10-minute promise), burst threshold (events K / window W), nudge card duration (default 60 s), merge window, intent-confidence floor, popups on/off, surface routing rules, blocked kinds (from "don't do this", reversible), behavioral rules list |
| Calendar | connected calendars, write-back per calendar, lead times per circle, plan or wish per circle, snooze defaults |
| Sharing | SuperTwin ID, devices, shared spaces, circles' default scopes, invites, blocklist |
| Public | public spaces, per-space permissions (answer, requests, bookings), followers, auto-post per space, rate limits |
| Economy | brand twin contact on/off, categories, price floors, task market on/off, payout account |
| Runs | trace viewer, filters, diff runs, quarantine, undo a run, cost dashboards |
| Data | storage per source, **two disk budgets** (events and derived 2 GB/yr · media 30 GB with retention window), database, export (SQLite and JSON), honest delete (span, source, all), logs, media, retention, trace detail days, debug export |

* * *
## 26. Phasing
| Phase | Name | Ships |
| --- | --- | --- |
| P1  | Solo Mac | Claude Code CLI only, plus local EmbeddingGemma 300M and reranker. WhatsApp, browser history and bookmarks, screen AX. Event log, live path, understanding, memory, people, spaces, tasks, calendar (derived), grounded bar, nudges, surface router (Mac only), feedback, traces. Executor-lite over web fetch (no browser yet). Retrieval: T0 hybrid with RRF, T1 route-and-plan for the bar, structured fields, coverage index, **bridges wired**, 2-hop graph walks |
| P2  | More inputs | Mail, calendars, notes, reminders, Drive, iMessage, clipboard, screenshots, voice input, ambient voice on Mac, Mouse Helper, scratchpad view, SuperTwin browser with cookie import, executor with browser, generative UI, meetings. Retrieval: T2 agentic (the executor lands here anyway) |
| P3  | Everywhere | Mobile app, WhatsApp self-chat and iMessage channels, OAuth and OpenRouter doors, other CLIs, local LLM option, social, commerce and entertainment sources, computer hand, AI keyboard |
| P4  | Together | SuperTwin ID, shared spaces, invites, twin-to-twin, relay, home server, bring-your-own cloud, calls |
| P5  | Public | Public spaces, follows, subscriptions, public twin, public page, twin economy, portable device |

* * *
## 27. Non-goals
1. No cloud copy of raw data on our servers. Ever.
  
2. No autonomous payments or private sends. The two gates are always the user's.
  
3. No paid APIs. No private-API scraping libraries on real accounts.
  
4. No feed. The twin surfaces work, not content.
  
5. No ads on any surface. Brand twins reach the user's twin only, and the user is paid.
  
6. **No second datastore.** The graph, the index and the world model live in one SQLite database, so a commit stays one transaction and a hybrid query stays one statement (§23.5).
  

* * *
## 28. Open questions
1. Local LLM: which fast passes are safe to move local first, and on which hardware floor?
  
2. Twin economy: pricing floors and the platform share need a market test.
  
3. Live scene: procedural only, or one generated image per city and season, cached?
  
4. Calls on the Mac need the iPhone nearby. Is a VoIP number on the user's own account a better default?
  
5. Graph traversal: the hop limit, the fan-out cap and the hub-exclusion list are guesses until measured on a real graph. What are they at 10k entities?
  
6. **Persistent cached session, a P3 candidate.** Instead of batching at all, hold one long-lived session per user with the pack as a cached prefix and append each event as a turn. Simulated at 693 calls a day, **6 s median latency and ~$61 a month** — better than the state gate on both. It is not P1 for three reasons: it depends on prompt caching surviving across `claude -p` invocations, which is unmeasured on P1's only door and would cost ~$180 a month if it fails; a stateful session breaks fixture replay and with it the golden-set regression gate; and a session that goes wrong stays wrong until rebuild, with no per-call isolation. **The unblocking measurement is small:** two `claude -p` calls sixty seconds apart with an identical 5k-token prefix, then read `cache_read_input_tokens`. Non-zero means revisit.
  
7. Screen event rate is the largest assumption in every cost figure here — 725 a day after content-hash dedup, carrying 87% of all characters. A 2x error there moves every number. Measure it in the first week of P1.
  

* * *
## 29. Glossary
1. **Event.** One captured thing. Immutable.
  
2. **Event log.** The append-only store of all events. Source of truth. Timeline.
  
3. **Stream.** Where events happen: a chat, an app session, a domain day, a document, a mail thread.
  
4. **Tier.** Processing class of a stream (1–4), from engagement and business type.
  
5. **Bundle.** A few minutes of life across all sources. The unit of a model call.
  
6. **Flush.** The moment a bundle is cut and sent. Never a claim that a burst ended.
  
7. **State gate.** The sub-100 ms lookup that decides whether an event flushes now or waits. Two hot conditions: the event touches open state, or it completes a burst. Code only, no model call, no content judgement.
  
8. **Hot event.** An event touching open state: a task waiting in this stream, an active episode, a bridge or entity in an active space. Also any event addressed to the twin (bar, self-chat, voice input). Flushes immediately.
  
9. **Cold event.** An event touching nothing yet known. Accumulates until the cold window closes.
  
10. **Cold window.** The idle and max timers for cold events, default 300 s / 540 s. The user-facing freshness setting. Never fires on an empty accumulator.
  
11. **Burst.** Four or more content-new events on one stream inside 180 s with no flush yet. The second hot condition. Covers a new topic the user is actively working on, before any space, task or episode exists for it. A count of engagement, never a judgement of meaning.
  
12. **Packer.** Code that adds context to a bundle: thread history, episodes, spaces, tasks, roster, calendar.
  
13. **Episode.** One burst of activity about one thing in one stream. Evidence unit.
  
14. **Space.** One goal across all streams. Holds summary, latest, plan, milestones, tasks, people, claims, enrichment, evidence.
  
15. **Space loop.** The cycle that keeps a space running until its goal is met.
  
16. **Milestone.** A dated sub-goal inside a space, only when the goal has stages.
  
17. **Arc.** A narrative thread of the user's life that spaces belong to.
  
18. **Task.** One actionable item with a type, steps, an owner, a gate flag.
  
19. **Scheduled step.** A step with a run time or a wait condition, fired by the scheduler.
  
20. **Follow-up.** A task created by the completion of another.
  
21. **Gate.** One of the two hard actions that need a tap: private send, money. Public posting is a soft gate, on by default and removable per space (§12.4).
  
22. **Approval token.** Single-use signed token minted by a tap. The only key to a gate.
  
23. **Claim.** One structured statement about a person, with evidence, confidence, validity, supersession.
  
24. **Evidence.** Event ids plus a verbatim quote.
  
25. **Roster.** Resolved participants injected into every prompt.
  
26. **Roles.** Sender, audience, receiver, mentioned receiver, mentioned third party.
  
27. **Provisional person.** A person built from mentions alone.
  
28. **Circle.** Relationship ring in the CRM. Drives priority, tone, lead times, scopes.
  
29. **Tone memory.** How the user talks to one person or group.
  
30. **Bridge.** Deterministic cross-source join key: URL, phone, order id, mail thread.
  
31. **Unsorted.** Holding area for episodes with no space yet.
  
32. **Prospective memory.** A future intention with a horizon and decay.
  
33. **Behavioral memory.** A rule that changes how the twin acts.
  
34. **Shared memory.** Memory that belongs to a relationship.
  
35. **Critic.** Cheap adversarial pass grading writes before commit.
  
36. **Live call.** The one model call per live bundle that understands and decides.
  
37. **Executor.** The agent loop performing one task.
  
38. **Executor-lite.** A bounded executor for prepared actions from the live path.
  
39. **Skill / how-to.** A reusable playbook per site or task type: steps, selectors, endpoints, waits, traps. Authored after the first success, replayed at zero model cost, repaired and refreshed when it breaks.
  
40. **Replay.** Running a stored skill without a model call.
  
41. **Thin context.** Not enough packed context to decide safely. Stops a pass or an executor and produces a question, never a guess.
  
42. **Artifact.** A finished piece of work: comparison, draft, brief, filled form.
  
43. **Nudge.** A card delivering finished work or a needed answer: intent, what I did, artifact. One of six kinds (§14.5). Auto-closes in 60 s. No cap, no cooldown, no quiet hours.
  
44. **Prepared.** The shelf of finished work waiting for the user.
  
45. **Surface router.** Decides where and when an artifact or question is delivered.
  
46. **Hands.** Connectors, the SuperTwin browser, the computer hand.
  
47. **SuperTwin browser.** The app's own Chromium with one logged-in profile.
  
48. **Self-chat.** The user's own "message yourself" chat on WhatsApp or iMessage, used as a channel.
  
49. **SuperTwin ID.** A device keypair plus a handle. Needed for Together and Public.
  
50. **Scope.** What a twin may share with another twin.
  
51. **Relay.** A server that forwards encrypted twin messages. Sees ciphertext only.
  
52. **Public store.** The separate store the public twin reads.
  
53. **Brand twin.** A business's twin that can send offers to user twins.
  
54. **Trace.** The record of one model call: prompt, context, output, cost.
  
55. **Golden set.** Hand-labelled evals run against the real model, grown from corrections.
  
56. **Age band.** History policy by event age.
  
57. **Retrieval tier.** T0 hybrid (local, no model call), T1 planned (one call writes a plan), T2 agentic (a budgeted search loop).
  
58. **Agentic search.** Retrieval as a loop: search, read, name what is missing, search again, within a budget.
  
59. **Retrieval plan.** The output of the Route pass: methods, entities, time range, filters, and whether the answer needs top-k or an exhaustive scan.
  
60. **Sufficiency check.** The code test that decides whether the evidence actually answers the question, or whether to escalate a tier.
  
61. **RRF.** Reciprocal rank fusion. Combines result lists by position, not by score, because BM25 and cosine scores are not comparable.
  
62. **Coverage index.** Per source, per date range, what exists and what was never captured. What makes "I only have WhatsApp back to Jan 2024" truthful.
  
63. **Seed.** The entity or event a graph walk starts from, resolved by lexical or vector retrieval.
  
64. **Hub node.** An entity connected to almost everything — the user themselves. Excluded from traversal because a walk through it reaches the whole graph.
  
65. **Typed field.** A structured column extracted alongside a claim's text: amount, date, status, merchant, order id, location, duration.
  
66. **Space birth.** The creation of a space, by inference, by the user asking, or by waking a dormant one.
  
67. **Sweep.** The retrieval run at every space birth that pulls related past episodes out of unsorted and the log into the new space, including the message that justified it.
  
68. **Propose-only mode.** The default early setting where inferred spaces go to the review queue instead of being created. Graduates to auto-create after two clean weeks. Never applies to spaces the user asked for.
  
69. **Self-reported.** Provenance of a claim stated by the user in their own words. Outranks an inferred claim when the two contradict.
