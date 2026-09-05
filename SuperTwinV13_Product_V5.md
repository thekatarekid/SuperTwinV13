# SuperTwin V13 — Product V5
SuperTwin is your AI digital twin. It knows what you know, remembers what you forget, does what you would do, and speaks for you when you let it.

This document says what the product is and how it works. It does not describe the current code.

* * *
## 0. Vision
### 0.1 What SuperTwin is
1. **A digital twin.** Not a chatbot, not an assistant app. A second version of you that lives in the digital world.
  
2. **It plays roles.** Personal assistant. Chief of staff. Second brain. Public face. These are jobs it does, not what it is.
  
3. **Three modes.** Solo (works for you). Together (works with other twins). Public (represents you to the world).
  
4. **One memory.** Every message, page, screen, sound, note and purchase you touch becomes part of it. Digital or not.
  
5. **Always with you.** Never in the way. Always watching over you, ready to help before you ask.
  

```
                 ┌──────────────────────────────┐
                 │           YOU                │
                 │  chats · screens · voice ·   │
                 │  notes · purchases · places  │
                 └──────────────┬───────────────┘
                                │ captures, with consent
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
1. **People are the duct tape.** Life runs across twenty apps. {==The user carries context between them by hand==}{>>by hand and in their minds, which creates cognitive overload.<<}{id="c1" by="user" at="2026-09-04T09:10:56.841Z"}. The twin carries it instead.
  
2. **People forget.** They saw it, read it, said it. Then it is gone. The twin remembers and finds it in seconds.
  
3. **Busywork eats life.** {==Booking, comparing, filling, following up==}{>>many more examples, not just these. searching, researching, errands, ordering groceries, paying bills, shopping (especially things that don't fascinate them), planning, etc<<}{id="c2" by="user" at="2026-09-04T09:11:43.516Z"}. Boring, mechanical, endless. The twin does it, and stops before the risky step.
  
4. **Coordination is slow.** {==A dinner plan takes forty messages over two days. Two twins settle it in seconds==}{>>for both the twins to do this, they should know their owner's schedule, food preferences, restaurant preferences, any other urgent commitments, their location at any time (in future as well) and traffic/time to get to the place, even how much they like the person or the relationship with the person and the context of the meeting, preparation, talking points, etc. Once plan is made it should then help / followup with a lot of other things as well like booking a cab, reminding the person, if there is something to buy and take it to the metthing help them with that, reminding them to ask about certain things they have been discussing, etc<<}{id="c3" by="user" at="2026-09-04T09:16:29.317Z"}.
  
5. {==**Public presence is a tax.** Everyone is expected to have a profile, a voice, an answer. A public twin does it for them==}{>>Personal branding. And on different platforms the context, subjects, branding, etc are different.<<}{id="c4" by="user" at="2026-09-04T09:20:57.335Z"}.
  
### 0.3 Principles
1. **Consent per source.** Nothing is read before the user says yes.
  
2. **Local first.** Data lives on the user's devices. {==Only the model call leaves==}{>>And if the model can be made local, nothing like it. We can provide option for local models, but very few users have powerful devices to support them. And even after that there might be some calls that might be needed to cloud models for truly heavy tasks.<<}{id="c5" by="user" at="2026-09-04T09:30:03.419Z"}.
  
3. **Minutes fresh.** Understanding lags life by seconds to minutes. Never more than 10 minutes.
  
4. **Do, then show.** Prepare the safe work. Ask only at the risky step.
  
5. **Grounded.** Every task, claim, nudge and answer cites its evidence.
  
6. {==**Unknown beats wrong.** Guessing a person, date or amount is a bug==}{>>so instead of giving something wrong, saying you dont know and asking is a better strategy<<}{id="c6" by="user" at="2026-09-04T09:39:06.786Z"}.
  
7. **Nothing is final.** Every state reopens. {==Every action undoes==}{>>This might not be possible for many actions like unsending a message or email. And for many actions it might cost money like cancellation fees to undo.<<}{id="c7" by="user" at="2026-09-04T09:41:51.007Z"}.
  
8. {==**Nothing runs away.** Spend, calls and concurrency are capped in code==}{>>We can remove this. This should be goal based. If the goal of the item is not achieved we should run it again, at the same time or at a later scheduled time<<}{id="c8" by="user" at="2026-09-04T09:45:18.133Z"}.
  
9. {==**Earned autonomy.** The twin gets more freedom as its track record grows. Never by default.==}{>>I think there should be only 2 modes - sending someone a DM or private mail (not to a business) or making payment type of risky things can be gated, rest can be done autonomously.<<}{id="c9" by="user" at="2026-09-04T09:46:54.945Z"}
  

* * *
## 1. {==User problems==}{>>should add all kinds of basic things as well - errands, ordering groceries, research, search, calling businesses / customer support, shopping boring things, booking tickets, making reservations, bill payments, etc. We need to capture all possible transaction type tasks, hard long tasks, boring tasks.<<}{id="c10" by="user" at="2026-09-04T09:50:07.657Z"}
| #   | Problem | What it feels like | What the twin does |
| --- | --- | --- | --- |
| 1   | Too many apps, too much juggling | "Where did I see that?" "Let me check five places." | One memory across all sources. One search. |
| 2   | Busywork | "I still have to do check-in, pay the pool, book the cab." | Finds the tasks, does them, stops before the risky step. |
| 3   | Forgetting | "Someone recommended a place in Goa. Who?" | Remembers every recommendation, with who said it and when. |
| 4   | Losing the thread | "What are we even doing about the trip?" | Spaces show the goal, the plan and the next step. |
| 5   | Coordination lag | Forty messages to pick a Saturday. | Twins negotiate. Humans confirm. |
| 6   | Follow-up debt | "I owe Sameer a reply since Tuesday." | Follow-up radar. Drafts ready in the user's voice. |
| 7   | Public pressure | "I should post more. I should reply to that DM." | Public twin answers within what is public. Drafts posts from real activity. |
| 8   | Privacy fear | "I don't want my life in a cloud." | Everything local. Filters at capture. Visible controls. |

* * *
## 2. Personas
1. **Aditya, 31, founder, Bengaluru.** {==Lives in WhatsApp, Slack, Chrome and a terminal==}{>>and Google drive, docs, sheets, presentations, email/gmail, as well as posting on twitter/x and linkedin<<}{id="c11" by="user" at="2026-09-04T10:59:41.037Z"}. {==Plans trips with friends, runs a company, forgets birthdays==}{>>and also builds personal brand, keeps updated with latest news from market, X/twitter, linkedin, networks a lot, goes to events.<<}{id="c14" by="user" at="2026-09-04T11:07:20.774Z"}. Wants a chief of staff he can trust with his data.
  
2. **Priya, 27, product designer, works remote.** {==Heavy Instagram saves, Notes, YouTube==}{>>and X bookmarks<<}{id="c12" by="user" at="2026-09-04T11:04:16.521Z"}. {==Wants a second brain that turns saves into plans==}{>>not just turns saves into into plans but also uses them in context / retrieves them for things where they can be helpful. wants to also stay in touch with the latest in industry, content, from certain people they follow.<<}{id="c13" by="user" at="2026-09-04T11:04:55.708Z"}. Hates busywork.
  
3. **Rahul, 38, parent of two, Pune.** {==School groups, insurance renewals, bills, doctor visits, family trips==}{>>should add grocery ordering, maid and cook salaries, etc<<}{id="c15" by="user" at="2026-09-04T11:38:17.422Z"}. Wants someone to keep the household running.
  
4. **Meera, 45, consultant, travels weekly.** Mail, calendar, expenses, clients. Wants follow-ups drafted and travel handled. Needs a public face for clients.
  
5. **Karan, 22, student and creator.** Public spaces, followers, content. Wants a twin that answers fans and drafts posts from what he actually does.
  

* * *
## 3. {==Use cases==}{>>You can refer to more life areas from this sheet in the folder - UseCases_MasterSheet.xlsx . But its a long list of use cases. Do not add all of them here, put a vey concise tabular view only like the one right now. See if it can be made better<<}{id="c16" by="user" at="2026-09-04T11:42:30.495Z"}
Grouped by life area. The twin manages the user's whole life. Any area, any space.

| Life area | Example spaces | What the twin does |
| --- | --- | --- |
| Travel | Goa trip in December, daily commute | Compares flights and stays, tracks who owes what, does check-in, books cabs up to payment |
| Money | Monthly bills, tax filing, SIP review | Tracks due dates, prepares payments, collects documents, flags renewals |
| Health | Gym restart, dad's cardiology follow-up | Books appointments, tracks reports, reminds medicines, keeps history |
| Home | Flat move, plumber, groceries | Shortlists, fills forms, orders repeat groceries up to checkout |
| People | Ma's birthday, Sameer follow-up | Reminds, drafts in the user's voice, tracks open loops |
| Work | v13 launch, hiring a designer | Pulls threads together, drafts updates, schedules, researches |
| Shopping | New laptop, Diwali gifts | Researches, compares, carts, waits for approval |
| Learning | Spanish A2, ML course | Tracks progress, schedules sessions, collects resources |
| Entertainment | Movies to watch, concert tickets | Try lists, ticket windows, bookings up to payment |
| Admin | Passport renewal, insurance claim | Forms, documents, appointments, deadlines |
| Events | Wedding, birthday party | Guest lists, vendors, shared spaces with family |
| Public | Reading list, Goa recommendations | Curated public space, answers followers, drafts posts |
### 3.1 {==A day with the twin==}{>>these examples look fine, but can be much better because these can be more proactive. for example the plan for the goal or followup tasks is missing - ma's birthday in 12 days, so it should help in more things about it like book reservation for dinner or book cake or suggest gifts, buy gifts, make cards or digital cards or collage, etc.<<}{id="c17" by="user" at="2026-09-04T12:01:01.981Z"}
```
07:00 Brief on phone: 3 things today, 1 approval waiting, Ma's birthday in 12 days 09:15 Ma on WhatsApp: "ticket book kar diya?" → twin: task "book Ma's train ticket", draft reply ready 11:20 User writes to Sameer on Slack for 10 min → twin: nothing (no help needed) 13:40 Goa gang decides dates → twin: space "Goa trip Dec" updates, flight compare prepared 14:02 {==User opens Airbnb → twin (nudge): "Compared 6 villas across 3 sites. 3 fit ₹6k/night."==}{>>There would be a lot more nudge type assists/helps as the user would obviously do something or the other the entire day and the supertwin system would keep capturing data all day. So just having a couple of helps/assists from the supertwin is highly unlikely. Also which surface to give the nudge is critical as well. If the user is not on or near the pc, sending nudge/notification on pc would be pointless and probably a whatsapp message or mail or imessage or sms or mobile app notification should be sent<<}{id="c18" by="user" at="2026-09-04T12:07:30.561Z"} 16:30 User: "remind Rohan about the advance" → draft in Hinglish, user taps Send 19:00 Twin to Rohan's twin: "Sat or Sun for dinner?" → back in 40 s: "Sat, no seafood" 22:00 {==Quiet hours. Twin processes the day. Nothing interrupts.==}{>>quiet hours is ok, but why should twin process the day at the end of the day. if the system is running constantly, wouldn't it keep processing all the time. What is there to process at the end of the day?<<}{id="c19" by="user" at="2026-09-04T12:08:52.906Z"}
```

* * *
## 4. {==User stories==}{>>These are obviously not all possible user stories for our product and nor are these generic enough to cover all of the product. At the same time, each of the user stories lacks details. For example - "I open a booking site and find the comparison already done." - this lacks what did the user do on the booking site, what kind of context can be created for the task, what was the goal and what kind of comparison it provided, where did it provide it.<<}{id="c20" by="user" at="2026-09-04T12:39:37.951Z"}
1. As a user, I connect WhatsApp and see my first space within 2 minutes.
  
2. As a user, I ask "what did we decide about Goa" and get an answer with quotes.
  
3. As a user, I open a booking site and find the comparison already done.
  
4. As a user, I approve a payment with one tap after seeing exactly what will happen.
  
5. As a user, I say "this is Karan's task, not mine" and it moves at once.
  
6. As a user, I pause capture for 2 hours from the menu bar.
  
7. As a user, I forget the last 10 minutes with one click.
  
8. As a user, I share a trip space with three friends and each twin holds its owner's tasks.
  
9. As a user, I let my twin find a dinner slot with Rohan's twin without opening a chat.
  
10. As a user, I make my reading list public and let people ask my twin about it.
  
11. As a user, I message my twin on WhatsApp from a train and it replies with a 👍 or a card.
  
12. As a user, I see every model call, its cost and what it saw.
  

* * *
## 5. Messaging
1. {==**Tagline:** _Your twin. Knows you. Works for you. Speaks for you._==}{>>This can be much much better<<}{id="c21" by="user" at="2026-09-04T12:48:15.060Z"}
  
2. **One-liner:** {==SuperTwin is a private AI twin that remembers everything you touch, finds what needs doing, and does it up to the step only you should take.==}{>>SuperTwin is a private AI twin that observes you and remembers everything about you (your data, whatever you did or said), finds what needs doing now and in future (in advance), and does it personalised to you before you ask, assisting you proactively.<<}{id="c22" by="user" at="2026-09-04T12:49:53.460Z"}
  
3. **Three promises:**
  
4. **Private.** Your data stays on your devices.
  
5. **Proactive.** It does the work before you ask.
  
6. **Present.** {==It is on your Mac, your phone, your chats, and with you==}{>>It is on your Mac, your phone, your chats, and with you everywhere.<<}{id="c23" by="user" at="2026-09-04T12:53:07.256Z"}.
  
7. **Never say:** chatbot, assistant app, productivity tool, AI feed.
  
8. **Always say:** twin, remembers, prepared, your voice, your call.
  

* * *
## 6. {==Success metrics==}{>>A few more important metrics is tasks done per day, estimated time saved per day, transactional tasks done per day, value of transactional tasks done per day<<}{id="c29" by="user" at="2026-09-04T13:09:17.505Z"}
North star: **hours handed back per user per week.**

| Area | Metric | Target |
| --- | --- | --- |
| Activation | First useful space on screen after first connect | ≤ 2 min |
| Coverage | Events filed into an episode | {==≥ 95%==}{>>What is an episode? And can / should 100% events go in episodes?<<}{id="c24" by="user" at="2026-09-04T12:57:32.103Z"} |
| Freshness | Live event to understood | ≤ 10 min, median ≤ 2 min |
| Task quality | Surfaced tasks the user keeps | {==≥ 80%==}{>>Should be >90%<<}{id="c25" by="user" at="2026-09-04T12:59:04.502Z"} |
| Nudge quality | Nudges opened or used | {==≥ 50%==}{>>should be >90% or else user will find it irritating<<}{id="c26" by="user" at="2026-09-04T12:59:25.002Z"} |
| Trust | Approvals granted without edit | {==≥ 70%==}{>>>90%<<}{id="c27" by="user" at="2026-09-04T12:59:55.348Z"} |
| Corrections | Corrections per 100 items | {==falling week over week==}{>>target <1%<<}{id="c28" by="user" at="2026-09-04T13:06:50.509Z"} |
| Safety | Risky steps without approval token | 0   |
| Cost | Steady-state model spend per month | ≤ $20 typical |
| Retention | Users active daily after 30 days | ≥ 60% |
| Together | Twin-to-twin threads settled without human chat | {==≥ 70%==}{>>>90%<<}{id="c30" by="user" at="2026-09-04T13:10:47.263Z"} |
| Public | Public questions answered without owner | {==≥ 80%==}{>>>90%<<}{id="c31" by="user" at="2026-09-04T13:10:56.446Z"} |

* * *
## 7. Product map
```
┌─────────────────────────────── SURFACES ────────────────────────────────┐ │ Mac app · Menu bar · Nudge · Mobile · WhatsApp/iMessage/Mail · │ │ Portable device · Home server · {==Public page==}{>>Why is Public Page a surface? Also I did not think of a public page, but public spaces. But yes, public page of a user can help too.<<}{id="c32" by="user" at="2026-09-04T13:11:16.913Z"} │ └───────────────────────────────────┬─────────────────────────────────────┘ │ ┌───────────────────────────────────▼─────────────────────────────────────┐ │ GROUNDED BAR search · chat · new task · new space · tell the twin │ └───────────────────────────────────┬─────────────────────────────────────┘ │ ┌──────────────┐ ┌─────────────────▼───────────────┐ ┌────────────────┐ │ │ PROACTIVE │ │ WORLD MODEL │ │ EXECUTION │ │ │ ASSIST │◄─┤ profile · CRM · spaces · tasks ├─►│ plan · act · │ │ │ {==watch · prep==}{>>what watch and prep only? it should do as well. or maybe the proactive assist and other path from capture to event log to understanding to world model and execution are the same or similar. what is the difference between those paths?<<}{id="c33" by="user" at="2026-09-04T13:12:42.092Z"}│ │ claims · patterns · skills │ │ verify · ask │ │ └──────┬───────┘ └─────────────────▲───────────────┘ └───────┬────────┘ │ │ │ │ │ ┌─────────────────┴───────────────┐ │ │ │ UNDERSTANDING │ │ │ │ bundle · episodes · file · claim │ │ │ └─────────────────▲───────────────┘ │ │ │ │ ┌──────▼────────────────────────────┴──────────────────────────▼────────┐ │ EVENT LOG append-only · local · encrypted · searchable │ └───────────────────────────────────▲───────────────────────────────────┘ │ ┌───────────────────────────────────┴───────────────────────────────────┐ │ CAPTURE connectors · browser · computer · inputs [ FILTER ] │ └───────────────────────────────────▲───────────────────────────────────┘ │ ┌───────────────────────────────────┴───────────────────────────────────┐ │ AI CONNECTOR CLI adapter · OAuth · OpenRouter [ SPEND RAILS ] │ └───────────────────────────────────────────────────────────────────────┘
```

* * *
## 8. Onboarding
Goal: something useful on screen within 2 minutes of the first connect.
### 8.1 Flow
```
Install → {==Pick brain==}{>>What does pick brain mean?<<}{id="c34" by="user" at="2026-09-04T13:22:49.244Z"} → Pick sources → Per source: history + consent → "{==Who I am==}{>>Which source data do we need to have for "who i am" to have substantial information? And what information will this card have?<<}{id="c35" by="user" at="2026-09-04T13:25:53.528Z"}" card → First space appears → Menu bar lives 30 s 30 s 20 s 30 s each ~2 min
```
### 8.2 Sources, history, permission
1. Source grid. Each tile says: what it captures, what it never captures, what it costs.
  
2. Connect one source at a time. Each connect is its own consent card with real counts.
  
3. Two windows per source:
  
4. **Index.** Kept and searchable. Default: everything. Costs disk only.
  
5. **Understand.** Sent to the model. Default: last 30 days. Costs money.
  
6. {==The consent card shows four numbers: events, cost, time, disk.==}{>>We might not have this information before connecting. And showing it before taking consent might arouse suspicion anyway.<<}{id="c36" by="user" at="2026-09-04T14:17:27.667Z"} Each labelled exact or about.
  
7. History runs newest first, one day at a time. Results stream in as they land.
  
8. macOS permissions asked in context, one at a time, with a reason. Accessibility, Contacts, Full Disk, Microphone.
  
9. {==The user can skip any source and come back later. The app never blocks on a source==}{>>The onboarding flow won't start again, so sources should be accessible from the home page<<}{id="c37" by="user" at="2026-09-04T14:22:31.391Z"}.
  
### 8.3 User identity
1. {==The twin builds a **"Who I am"** card from the first data: name, city, work, key people, active goals.==}{>>Which source data do we need to have for "who i am" to have substantial information? And what information will this card have? We might not get all the data with 1 or 2 sources. And active goals would require LLM to process the data. If this is not part of onboarding then I understand we can get this data after processing.<<}{id="c38" by="user" at="2026-09-04T14:23:41.904Z"}
  
2. {==The user confirms or edits each line. This seeds the User Profile==}{>>This confirmation seems unnecessary. I understand editing and thats fine. Also which line does "each line" refer to<<}{id="c39" by="user" at="2026-09-04T14:25:59.088Z"} (§11.4).
  
3. {==The card learns voice: language mix, tone, emoji habits. Used for every draft.==}{>>We also might not have this data in time during onboarding. This would require LLM processing.<<}{id="c40" by="user" at="2026-09-04T14:28:52.556Z"}
  
4. {==One local keypair is the identity. It signs consents, approvals and twin messages.==}{>>what does this mean? is it some kind of encryption? and what does this ensure?<<}{id="c41" by="user" at="2026-09-04T14:30:44.130Z"}
  
### 8.4 Login
1. **Solo mode needs no account.** No email, no password, no server.
  
2. **SuperTwin ID** is optional. Public key plus handle. Needed for Together and Public modes.
  
3. {==AI provider logins go through the AI Connector (§9), never through us.==}{>>Yes but if a connector is already logged in, we should show that the AI service is connected<<}{id="c42" by="user" at="2026-09-04T14:37:18.478Z"}
  

* * *
## 9. AI Connector
The twin's brain is whichever model the user already pays for. Three doors, one interface.

```
                 ┌────────────┐  ┌────────────┐  ┌────────────┐
                 │ CLI adapter│  │   OAuth    │  │ OpenRouter │
                 │ claude ·   │  │ anthropic ·│  │ any model  │
                 │ codex ·    │  │ openai ·   │  │ one key    │
                 │ gemini ·   │  │ google     │  │            │
                 │ grok       │  │            │  │            │
                 └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
                       └───────────────┼───────────────┘
                                       ▼
                          ┌────────────────────────┐
                          │  ONE CONTRACT          │
                          │  prompt in · JSON out  │
                          │  budget · trace        │
                          └────────────┬───────────┘
                                       ▼
                       roles: fast · deep · local
```
### 9.1 CLI adapter
1. Uses the user's installed CLI and subscription. Claude Code, Codex, Gemini CLI, Grok, others.
  
2. One contract: prompt in, JSON out, per-call budget, trace out.
  
3. Tools reach the CLI as MCP servers. Connector names never leave the machine.
  
4. Default door. Cheapest for heavy users.
  
### 9.2 OAuth
1. Sign in to a provider directly. Token stays in Keychain.
  
2. Used when no CLI is installed, or on mobile.
  
### 9.3 OpenRouter key
1. Paste one key. Any model, any provider.
  
2. Used for cheap fast models, open models, or a specific provider.
  
### 9.4 {==Model roles and rails==}{>>We can lend a lot of this from V13 settings. Every LLM/model/agent step should have model selection and switch.<<}{id="c43" by="user" at="2026-09-04T14:49:14.846Z"}
1. Three roles, each with its own picker: **fast** (digest, gate, critic), **deep** (understanding, planning, execution), **local** (embeddings, whisper, redaction).
  
2. Reasoning level per role.
  
3. Fallback ladder. If a door fails, the next door takes over. The user sees a banner, never silence.
  
4. Spend rails: per call, per hour, per day. Breach pauses background work and asks. Chat is never latched.
  
5. "Stop all model activity" switch. Persists across restart.
  

* * *
## 10. Data ingest and storage
### 10.1 Sources and history
| Group | Sources | Door |
| --- | --- | --- |
| Messages | WhatsApp, iMessage, SMS, Slack, Mail, Instagram DMs, X DMs | Connector, Computer |
| Notes and docs | Apple Notes, Google Keep, Notion, Drive, Docs, Sheets, Slides | Connector |
| Tasks and time | Apple Reminders, Google Tasks, Google Calendar, Apple Calendar | Connector |
| Web | Browser history, bookmarks, open tabs, page text | Connector, Browser |
| Social | Instagram, X, YouTube, TikTok saves, posts, watch history | Export, Browser |
| Screen | Accessibility tree of the front window on every switch or pause | Computer |
| Audio | Meetings, calls, ambient voice on Mac and phone | Computer, Mobile |
| Commerce | Amazon, Blinkit, Zomato, Swiggy, Zepto, Uber, MakeMyTrip, Goibibo | Mail, Browser |
| Entertainment | Netflix, Hotstar, Spotify, BookMyShow | Browser, Export |
| AI chats | Claude, ChatGPT, Gemini history | Files, Export |
| Self | Everything the user does inside SuperTwin | Built in |

1. Each source declares: how far back it can go, live or poll, and which door it uses.
  
2. Each source has its own Index and Understand windows (§8.2).
  
3. Widening a window later replays stored events. Never a re-import.
  
### 10.2 Input methods
Ways the user pushes things in, beyond passive capture.

1. **Apps.** Share sheet on Mac and phone. Share anything to the twin.
  
2. **WhatsApp and iMessage.** Message your own twin. Text, voice, photo, forward.
  
3. **Clipboard.** {==Toggle to watch. Copy something twice to send it to the twin.==}{>>What is "Toggle to watch". And why should every copy (single copy not double) not be sent to clipboard?<<}{id="c44" by="user" at="2026-09-04T14:55:21.557Z"}
  
4. **Screenshot.** {==Any screenshot lands in the scratchpad==}{>>Why in scratchpad? why not as event and then to the general path?<<}{id="c45" by="user" at="2026-09-04T14:56:40.745Z"} and gets read.
  
5. **Voice input.** Hold a key, speak, release. Works in any app. Dictation with intent.
  
6. **Ambient voice.** Always-on mic, local transcription, speaker separation. Off by default.
  
7. **Mouse Helper.** {==Drag a box around anything on screen==}{>>drag a box to send as context would have to be built right? Can it also be a way to screenshot a part of the screen?<<}{id="c46" by="user" at="2026-09-04T14:59:31.587Z"}. {==Ask about it or act on it.==}{>>The suggested actions would require model to understand what the selected box contains right? would probably create significant lag in showing up?<<}{id="c47" by="user" at="2026-09-04T15:02:12.409Z"} Any app, any window.
  
8. **Keyboard.** AI keyboard on phone. Suggestions and autocomplete from the twin's memory.
  

```
 ┌──────────────── Mouse Helper ────────────────┐
 │  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐            │
 │    Villa Sol · ₹5,400/night      ← dragged  │
 │    ★ 4.8 · pool · 6 beds           box      │
 │  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘            │
 │   ◆ Add to Goa trip › Stay                   │
 │   ◆ Compare with saved villas                │
 │   ◆ Ask…                                     │
 └──────────────────────────────────────────────┘
```
### 10.3 Connectors, Browser, Computer
Three hands. Every source and every action uses one.

1. **Connectors.** {==Official APIs and exports. First choice. Fast, safe, cheap==}{>>Not just official APIs, but many services do not have APIs. For example whatsapp has whatsmenow. Other services may have other similar. We are going to use free methods only, no paid APIs<<}{id="c48" by="user" at="2026-09-04T15:03:17.175Z"}.
  
2. **Browser.** {==The SuperTwin Browser. One Chromium, one logged-in profile. For sites with no API and for acting on the web.==}{>>it should take / import cookies from user's other main browsers to not ask for login to services again.<<}{id="c49" by="user" at="2026-09-04T15:05:01.042Z"}
  
3. **Computer.** Accessibility and input control of native apps. When there is no API and no web.
  
4. Rules: read at human cadence. Never automate login or 2FA. Stop on any challenge page.
  
### 10.4 Data filter
Privacy is enforced at capture. What never enters the log never leaks.

```
  source ─► [ never-list ] ─► [ user lists ] ─► [ time rules ] ─► event log
              incognito         apps · sites       quiet hours
              passwords         chats · senders    work only
              secret fields     folders · people   weekends off
              banking (default)
```

1. Never captured: incognito windows, password managers, secret fields, keys, banking apps by default.
  
2. User lists: apps, sites, chats, senders, folders, calendars, people.
  
3. {==Time rules: quiet hours, work hours only, weekend off.==}{>>This is not needed<<}{id="c50" by="user" at="2026-09-04T15:19:45.611Z"}
  
4. **Forget the last N minutes.** One click in the menu bar. Hard delete with cascade.
  
5. **Private moment.** {==Hold a key to pause everything for 15 minutes==}{>>we can do it from the menu bar instead of the key<<}{id="c51" by="user" at="2026-09-04T15:20:16.764Z"}. Indicator turns grey.
  
6. Per source: pause, disconnect, delete. Delete shows a preview count first.
  
7. Filters apply to index, understanding and search alike. No side channel.
  
### 10.5 Storage
1. One append-only event log. {==Raw payload kept. Text compressed.==}{>>what does this mean?<<}{id="c52" by="user" at="2026-09-04T15:26:33.523Z"}
  
2. Full-text search and chunk embeddings over everything indexed.
  
3. Screen text stored as anchor plus diff.
  
4. {==Budget: about 1 GB per year of life with screen on.==}{>>make budget configurable in settings. 1GB is too less. Default 10GB.<<}{id="c53" by="user" at="2026-09-04T15:27:18.210Z"}
  
5. {==Encrypted at rest. Optional encrypted sync to phone and home server (§17).==}{>>Do not encrypt. We will do it later if the product is working fine. Not encrypting is key to debugging and viewing app data and logs properly<<}{id="c54" by="user" at="2026-09-04T15:28:22.106Z"}
  

* * *
## 11. Data processing, organizing, understanding
### 11.1 Processing priority
```
  LIVE ─────────────────────────────────────────► always first
  HISTORY  newest day ► older days
           within a day:   chats ► screen ► browser ► rest
           within a source: DMs ► groups I replied in ► groups I never did
           within a stream: things I touched ► things I only saw
  USER PIN ─────────────────────────────────────► jumps the queue
```

1. Live before history. Always.
  
2. {==Priority score per stream: engagement × recency × circle weight. Ordering only, never value.==}{>>there is also another rule for priority order - DMs and groups where the user replies, updates from businesses, messages from groups and DMs user does not reply or has never replied, marketing/spam from businesses. If its already covered by your priority rule then its fine, otherwise we should consider this.<<}{id="c58" by="user" at="2026-09-04T15:47:57.896Z"}
  
3. {==Low-signal streams get a coarse digest, later==}{>>What are streams. What are low signal streams, what are medium or high signal streams.<<}{id="c55" by="user" at="2026-09-04T15:38:30.878Z"}. Never dropped. {==One reply promotes a stream==}{>>What does this mean<<}{id="c56" by="user" at="2026-09-04T15:39:04.270Z"}.
  
4. Age bands decide what history yields: recent gives everything, {==old gives claims and patterns, never stale tasks==}{>>why should it also not generate dormant spaces and closed/done/archived/probably done tasks. it would help us build a richer historical understanding of the user. We don't need to surface them as active.<<}{id="c57" by="user" at="2026-09-04T15:39:31.499Z"}.
  
5. {==The user can pin a source or a chat to the front==}{>>add pinning a part of the source like a website from browser or an app from screen recording or specific chat or sender from messaging service or specific mail id<<}{id="c59" by="user" at="2026-09-04T16:01:04.418Z"}.
  
### 11.2 Chunking and episodes
1. The unit of a model call is **time, not stream**. A bundle is a few minutes of life across all sources.
  
2. Live: flush on 45 s idle or 2 min max. History: one calendar day per call.
  
3. The model cuts bundles into **episodes**: one burst of activity about one thing in one stream.
  
4. Episodes chain across time. {==Same topic weeks later is a new episode linked to the old==}{>>Aren't linked episodes about same topic essentially all go into the same space? where the topic is the space or a part of the space?<<}{id="c60" by="user" at="2026-09-04T16:14:03.773Z"}.
  
5. Every episode lists its events. Every episode goes to a space or to unsorted.
  
6. A critic grades every write before commit. Wrong merges destroy. Wrong splits repair.
  
### 11.3 Memory system
Six layers. Each is rebuilt from the one below.

```
  ┌─────────────────────────────────────────────┐
  │ 6 WORKING     scratchpad of a running task   │  hours
  ├─────────────────────────────────────────────┤
  │ 5 PROCEDURAL  workflows · habits · skills ·  │  learned
  │               tone per person                │
  ├─────────────────────────────────────────────┤
  │ 4 IDENTITY    profile · CRM · life narrative │  slow-changing
  ├─────────────────────────────────────────────┤
  │ 3 SEMANTIC    claims · entities · graph      │  with validity
  ├─────────────────────────────────────────────┤
  │ 2 EPISODIC    episodes · spaces · tasks      │  with evidence
  ├─────────────────────────────────────────────┤
  │ 1 ARCHIVE     raw events · FTS · embeddings  │  immutable
  └─────────────────────────────────────────────┘
```

1. Consolidation runs continuously: dedupe at write, merge and split hourly, deep compression when idle.
  
2. Nothing is deleted by consolidation. Old claims get an end date.
  
3. Retrieval is recall then rerank. Never a full scan. Prompt size stays flat as memory grows.
  
### 11.4 User profile
1. Basics: name, home, hometown, addresses, contacts, social handles, birthday, anniversaries.
  
2. Life: occupation, education, partner, family, friends, coworkers.
  
3. {==Narrative: life goals in the user's own words, refined by the twin.==}{>>Narrative should not just have user's life goals, but a narrative of user's life which is more than just goals.<<}{id="c128" by="user" at="2026-09-05T06:34:26.952Z"}
  
4. Traits: claims, preferences, interests, habits, patterns, workflows (§11.10).
  
5. Voice: tone per audience. DMs, groups, work, public.
  
6. Every line has evidence and confidence. The user can edit any line.
  
### 11.5 Personal CRM
1. One card per person. Includes people with no contact info, built from mentions alone.
  
2. Card: same fields as the profile, plus relationship, circle, last context, open follow-ups, their goals, their voice.
  
3. Circles: partner, family, close friends, friends, coworkers, services, acquaintances, {==businesses==}{>>businesses can be of 3 types - ones with whom the user transacts actively and they send updates, the ones with whom user has transacted or interacted but in the past and has no active relationship and the ones who send user marketing/spam and user has never interacted with them.<<}{id="c61" by="user" at="2026-09-04T16:38:45.513Z"}.
  
4. Circles drive priority, tone, nudge thresholds and whose tasks are yours.
  
5. **Follow-up radar.** {==Who owes you a reply. Who you owe==}{>>along with when should be followed up and how much in advance should the agent start acting on it.<<}{id="c62" by="user" at="2026-09-04T16:42:00.172Z"}. {==Birthdays and anniversaries ahead==}{>>For some the user would want to plan things, for some others the user might just want to wish. Different advance notice is needed for different. Most likely depends on the circle.<<}{id="c63" by="user" at="2026-09-04T16:42:40.901Z"}.
  
6. Audience tone: {==how the user talks to this person in DMs and in groups. Used for drafts.==}{>>This should include any re-used phrases, nicknames, etc as well for that particular person depending on DMs or groups<<}{id="c64" by="user" at="2026-09-04T16:46:43.284Z"}
  
7. Merge and split people by drag. Undo always.
  
### 11.6 Spaces
A space is one goal. It is the unit of organization and of action.

```
  LIFE AREA        Travel
     └─ SPACE      Goa trip with Rohan in December          [active · one-time · ephemeral · shared]
          ├─ MILESTONE   Flights ✓ ── Stay ◐ ── Day trips ○
          │      └─ TASK  Book villa        ● executing
          │      └─ TASK  Collect ₹5k advance from Karan   due Sep 2
          ├─ PLAN        lock villa → pay pool → cabs
          ├─ PEOPLE      Rohan · Tanvi · Karan
          ├─ CLAIMS      budget ₹6k/night · 4 people
          ├─ ENRICHMENT  fares today ₹4.8–5.6k · weather
          └─ EVIDENCE    episodes from WhatsApp · browser · screen
```

1. Life areas: Work, Health, Money, Home, People, Travel, Shopping, Learning, Entertainment, Admin, Events, Public. Editable.
  
2. Goals are **inferred** from intent, money, dates and repetition. The user edits the label and the goal.
  
3. Space properties:
  

| Property | Values | Behaviour |
| --- | --- | --- |
| State | active, dormant | Dormant wakes on new signal or user ask |
| Horizon | short-term, long-term | Drives brief cadence and nudge patience |
| Life | permanent, ephemeral | Ephemeral expires and archives after its date |
| Cycle | one-time, recurring | Recurring spawns a fresh cycle each period |
| Access | private, shared, public | See §18, §19 |
| Players | solo, collaborative | Collaborative has owners across users |

4. {==Space types set default milestones and task templates: trip, purchase, event, health plan, subscription, project, relationship, learning, admin, routine, finance, home.==}{>>space types dont need to have default milestones or task templates. these should be personalized for the user. also space types would be much more the the ones listed here.<<}{id="c65" by="user" at="2026-09-04T17:22:21.965Z"}
  
5. {==A space enriches itself with web data==}{>>and more user data, if relevant<<}{id="c67" by="user" at="2026-09-04T17:26:17.943Z"}: {==prices, options, deadlines, weather, news==}{>>and more things, not just these. whatever is relevant to the goal or its plan or making its plan.<<}{id="c66" by="user" at="2026-09-04T17:23:51.381Z"} relevant to the goal.
  
6. {==A space holds a plan: goal, milestones, next actions==}{>>goal, plan, milestones (if applicable), tasks, next actions, followup actions, etc. space should also have a summary and latest updates<<}{id="c68" by="user" at="2026-09-04T17:28:53.252Z"}. {==The plan updates when the world changes==}{>>space will keep updating plan and tasks and execute the tasks and followup tasks till the goal is achieved. Basically keep running the space in a loop till goal is achieved<<}{id="c84" by="user" at="2026-09-04T18:48:43.093Z"}.
  
7. Cross-source joins happen in the space. A chat, a page and a screen about one trip meet here.
  
8. Unsorted is a holding area, not a grave. Reviewed at every space birth.
  
9. {==Try lists and bucket lists become dormant space seeds. "Want to do Hampi trek" waits until a long weekend appears==}{>>good idea. but user's own recommendation lists can become a try/bucket list for other users that they can subscribe to. so this has application in public space/ public recommendation / public page as well.<<}{id="c69" by="user" at="2026-09-04T17:34:24.243Z"}.
  
### 11.7 Space list and view
1. **List.** Grouped by life area. Sort by activity, deadline or pin. Dormant collapsed.
  
2. Row: label, area, next milestone, task count, freshness, people chips.
  
3. **View.** Goal at top. Milestone rail. Task list. Prepared artifacts. Evidence timeline. People.
  
4. Every element opens a "why" panel: evidence quotes, confidence, trace.
  
5. Drag an episode or task to another space to correct filing.
  
### 11.8 Tasks
1. **Explicit.** The user or someone else said it.
  
2. **Implicit.** Entailed by what happened. "Flights booked" entails "web check-in".
  
3. **Suggested.** From plan gaps. Clearly marked. {==At most two per space per day.==}{>>we should not put limits of any kind. if the plan needs the task, it should be present.<<}{id="c70" by="user" at="2026-09-04T17:45:40.045Z"}
  
4. {==Task types: research, message, follow-up, shopping, booking, form, browse, search, filing, monitoring, errand, creation, reminder, payment.==}{>>there can be many more task types<<}{id="c71" by="user" at="2026-09-04T17:50:25.146Z"}
  
5. {==Steps inside a task: gather, plan, research, execute, verify, report.==}{>>gather is gather context. but the steps can be depending on task.<<}{id="c72" by="user" at="2026-09-04T17:51:45.846Z"}
  
6. Risk class:
  

| Class | Meaning | Examples |
| --- | --- | --- |
| auto | Do it, show it | research, compare, draft, fill, cart |
| approve-final | Do everything, stop at the last step | pay, send, book |
| approve-first | {==Ask before starting==}{>>do we really need this type of risk class? because even these can go till the last safest step? which cases will this risk class help? (unless the first step itself is the risky one)<<}{id="c73" by="user" at="2026-09-04T17:54:26.408Z"} | anything touching another person's account |
| advise-only | Only tell | {==medical, legal, money advice==}{>>but even these tasks can be executed to some level, to why should these be advise only.<<}{id="c74" by="user" at="2026-09-04T17:57:00.164Z"} |

7. **Scheduled tasks.** Timers from computable windows. Check-in at T-48h, ticket window at 10 am. Auto only when time-bound and safe. Otherwise a confirm card.
  
8. **Follow-up tasks.** When a task closes, {==the twin proposes the next one or two==}{>>proposes and even schedules. it might even be part of the plan. or it might be part of updated plan if the task completion causes the plan to update.<<}{id="c75" by="user" at="2026-09-04T17:58:08.113Z"}, with the reason.
  
9. Owner is resolved from roles. Other people's tasks are not the user's. {==At most a monitoring item==}{>>or a followup for the user<<}{id="c76" by="user" at="2026-09-04T17:59:44.913Z"}.
  
10. {==Closure needs hard evidence. One-sided intent gets "looks done, confirm?".==}{>>what is one sided intent? and we cannot have tasks open indefinitely, we need to find signals that a task has closed and signals are low confidence or past due date, etc we should ask the user if the tasks are done.<<}{id="c77" by="user" at="2026-09-04T18:00:31.009Z"}
  
### 11.9 Prioritized task list
1. One list across all spaces. Score: deadline, risk, value, effort, {==who is waiting==}{>>it can be for user themselves with no other person waiting. that does not make it less important vs those tasks with other people waiting.<<}{id="c79" by="user" at="2026-09-04T18:24:10.658Z"}, user pins.
  
2. {==Row: title, space chip, due, status, one-tap action.==}{>>also include people chips or people involved in the row<<}{id="c78" by="user" at="2026-09-04T18:23:26.658Z"}
  
3. Sections: **Needs you** → **Today** → **This week** → **Later** → **Waiting on others**.
  
4. {==Filter by life area, space, person, type.==}{>>there needs to be sort as well.<<}{id="c80" by="user" at="2026-09-04T18:28:58.591Z"}
  
5. The twin explains the order on hover. Reorders are learned.
  
### 11.10 Claims and traits
1. {==Kinds: claim, fact, belief, preference, interest, like, dislike, opinion, recommendation, try-list item, pattern, habit, workflow, relationship.==}{>>should also have likes and dislikes, fears, etc<<}{id="c129" by="user" at="2026-09-05T06:36:00.176Z"}
  
2. {==Recommendations carry a type: place, activity, recipe, product, book, show, service.==}{>>can be more types<<}{id="c81" by="user" at="2026-09-04T18:34:10.775Z"}
  
3. Patterns are detected across time: monthly rent, Friday dinners, annual renewals, gym streaks.
  
4. Workflows are how the user does recurring things. The twin learns them and offers to run them.
  
5. {==Every claim: subject, evidence quote, confidence, valid from, valid to.==}{>>it can also supersede another claim or superseded by another claim (old claim would be updated in that case)<<}{id="c82" by="user" at="2026-09-04T18:41:52.132Z"}
  
6. Contradictions never overwrite. A judge decides supersede or coexist.
  
7. Ads are never preferences. Jokes are tone, not beliefs.
  

* * *
## 12. Execution
```
   task ─► CONTEXT ─► PLAN ─► [ act ─► verify ]─┐ not met ─► replan
              │         │           ▲            │
              │         │           └────────────┘
              │         │                        met
              │         │                         ▼
              │         │              risky step left?
              │         │             no ─► done ─► FOLLOW-UP
              │         │             yes ─► approval card ─► user taps ─► done
              ▼         ▼
        missing info? ─► one precise question ─► pause
```
### 12.1 Context collection
1. The executor packs: space plan, open tasks, relevant claims, people involved, recent episodes, past attempts.
  
2. Retrieval, not enumeration. Top matches with quotes. Prompt size stays flat.
  
3. {==Web context fetched when needed: prices, availability, hours, forms.==}{>>not just these things, but whatever is needed or helps<<}{id="c85" by="user" at="2026-09-04T18:51:14.289Z"}
  
4. Missing information gets {==one precise question==}{>>no limits on the number of questions (if possible can also combine all of the missing information and present it like a single question rather than separate questions), but if you have any information but not sure about it, present it to the user and ask the user to confirm<<}{id="c83" by="user" at="2026-09-04T18:45:30.985Z"}. The task pauses. Never a guess.
  
### 12.2 Planning and steps
1. Plan first. Write acceptance criteria before acting.
  
2. {==Steps are typed: gather, research, compare, draft, fill, book, verify, report.==}{>>there can be more step types. and a step can also be scheduled to run at a certain time in future. A cron or scheduler needs to then run it at the right time. example - bookings open at 10am tomorrow, the next step of the task gets executed at that time. it can also be that instead of step a new task is scheduled and created for tomorrow 10am. whatever is the better architecture for the system to keep working on it and not drop it.<<}{id="c95" by="user" at="2026-09-04T19:12:02.217Z"}
  
3. {==The risky step is always last: pay, send, book, delete, change an account.==}{>>this is not necessary and depends on the task, but its best if its last. a task can always have followup tasks depending on how the task was executed<<}{id="c86" by="user" at="2026-09-04T18:56:53.497Z"}
  
4. Plans are visible. {==The user can edit or remove a step before it runs==}{>>for truly proactive experience the plan would just get executed and manual updating of the plan won't be possible. what would be possible would be followup "chat" or "feedback" on the basis of which the plan can change and task can be re-executed<<}{id="c87" by="user" at="2026-09-04T18:58:00.063Z"}.
  
### 12.3 Execution with LLM, tools, skills, browser, computer
1. Loop: act → verify against criteria → replan on failure. {==Never repeat a failed step unchanged==}{>>only repeat a failed step in the same way if it failed due to somethings like network error and can be executed successfully without changing anything. otherwise change the plan/steps<<}{id="c88" by="user" at="2026-09-04T19:00:18.842Z"}.
  
2. Tools: {==world-model read, web fetch, drafts, files, calendar, connectors, browser, computer.==}{>>execution can also be done by llm itself, but thats not a separate tool. there can be more tools as well, and if some tool which is not connected is needed either the plan should be changed to try executing without it with whatever is available or if it cannot be done at all without it, then ask the user to connect<<}{id="c89" by="user" at="2026-09-04T19:01:51.128Z"}
  
3. **Skills.** Reusable playbooks per site and per task type. The twin writes one after the first success and reuses it.
  
4. {==Browser: agent tabs in the user's logged-in profile. Never touches the user's own tabs. Replayable.==}{>>should use our in app browser, not user's browser. our in app browser should also ask for login to various services or take cookies to login to the services automatically.<<}{id="c90" by="user" at="2026-09-04T19:03:39.742Z"}
  
5. Computer: native app control through accessibility. {==Same rules as browser.==}{>>what are these rules?<<}{id="c91" by="user" at="2026-09-04T19:05:43.522Z"}
  
6. Budget per task: cycles and money. {==On exhaustion: best partial, gaps, next idea.==}{>>if needed, ask user to extend cycles or budget<<}{id="c92" by="user" at="2026-09-04T19:07:28.751Z"}
  
7. Risky step is code-gated. The send path refuses without a single-use approval token.
  
### 12.4 Working memory and scratchpad
1. Each running task has a scratchpad: findings, drafts, links, screenshots, attempt log.
  
2. The user's own scratchpad (notes, clips, screenshots, voice) is a shared surface with the twin.
  
3. {==Scratchpad items graduate to a space, task or claim by one drag.==}{>>shouldn't this happen automatically, not manually?<<}{id="c93" by="user" at="2026-09-04T19:10:35.060Z"}
  
4. Working memory is kept after completion for review. {==Compressed after 30 days.==}{>>what does compressing mean? what does it do?<<}{id="c94" by="user" at="2026-09-04T19:11:24.326Z"}
  
### 12.5 Follow-up tasks and plan
1. Completion triggers a next-step pass. Output: one or two next tasks with the reason.
  
2. Reminders, scheduled checks and monitoring items are follow-ups too.
  
3. The space plan updates. {==Milestones close. The next milestone becomes active.==}{>>if milestones apply to the space /goal that is.<<}{id="c96" by="user" at="2026-09-04T19:16:46.021Z"}
  
4. The outcome feeds memory. A finished trip updates preferences, people and patterns.
  

* * *
## 13. UI surface
### 13.1 Generative UI
1. Results are typed: comparison table, itinerary, draft, approval card, brief, checklist, receipt, map, calendar slot, form preview, chart, gallery.
  
2. The model picks composition and content. The design system owns color, type and layout.
  
3. Every card is interactive: sort, filter, edit, approve, ask a follow-up.
  
4. {==Long text is the fallback, never the default.==}{>>if there needs to be text, it should be properly formatted - sections, bullet points, appropriate bold, italics wherever it makes sense, etc<<}{id="c97" by="user" at="2026-09-04T19:37:40.247Z"}
  
### 13.2 {==Browser WebView==}{>>this is inbuilt supertwin browser and its webview<<}{id="c98" by="user" at="2026-09-04T19:38:16.122Z"}
1. Any answer or card can embed a live page from the SuperTwin Browser.
  
2. {==The user finishes the risky step in the embedded page: pay, confirm, send.==}{>>this is not true always. for example - whatsapp would use whatsmenow, not browser - because we cannot open 10s of browser windows with whatsapp on them<<}{id="c99" by="user" at="2026-09-04T19:42:41.186Z"}
  
3. {==Agent sessions replay as a screencast on demand.==}{>>does this mean we will record agent sessions as videos?<<}{id="c100" by="user" at="2026-09-04T19:43:52.140Z"}
  

* * *
## 14. Proactive assist
### 14.1 What it does
```
  last seconds of activity ─► can I name the goal? ─ no ─► nothing
                                      │ yes
                                      ▼
                          is it novel + not muted + not quiet hours?
                                      │ yes
                                      ▼
                          prepare 3–4 steps ahead (auto class only)
                                      │
                                      ▼
                          nudge · prepared shelf · space banner · bar chip
```

1. Watches the last seconds of activity across sources.
  
2. Names what the user is trying to do. Acts only when it can name it.
  
3. Prepares the next step, three or four ahead. Comparison, draft, filled form, cart.
  
4. Auto class only. Never pays, sends, books or changes an account.
  
5. "Nothing" is the right answer most of the time.
  
### 14.2 Menu and nudge surface
1. **Nudge.** One small card, top-right, one at a time. Intent line, what I did, artifact peek, Open, Not now.
  
2. **Menu bar panel.** Needs you → Prepared → Today. Capture state and pause live here.
  
3. **Prepared shelf** on Home and in the space. Same artifact, one status, no duplicates.
  
4. Grounded bar shows one chip when a fresh relevant artifact exists.
  
5. No daily cap. Frequency comes from novelty, confidence, cooldowns and dismissals.
  
6. Quiet hours. Only a real deadline can break them.
  
7. Two dismissals in a context mutes that context. "Don't do this" is permanent until reversed.
  

* * *
## 15. Feedback and learning
```
  edit · drag · dismiss · approve · "tell the twin"
        │
        ▼
  correction event ─► world model update (now) ─► golden eval case (later)
        │
        ▼
  effects: filing hints · task thresholds · nudge throttles · tone · brief timing
```

1. **Direct manipulation is correction.** Edit a title, drag a task, move a person. Undo chip. No dialogs.
  
2. One menu everywhere: Edit, Remove, Tell the twin.
  
3. **Tell the twin** locks the chat to the object. "This is Karan's, not mine." Applied at once, shown, undoable.
  
4. Quick chips per type: Not mine, Already done, Not true, Outdated, Merge into.
  
5. Signal weights: explicit feedback > edits > dismissals > views. Artifact use: edited > opened > glanced.
  
6. Every correction drafts a golden eval case. No prompt ships that scores worse.
  
7. **Earned autonomy.** Each task type has a trust score. High trust moves approve-first to auto. Money and messaging never move.
  

* * *
## 16. Grounded chat, search, new task, new space
### 16.1 {==One bar==}{>>Understand the query or input in the bar and start executing towards what needs to happen<<}{id="c103" by="user" at="2026-09-04T21:05:18.446Z"}
1. One input. No modes. The bar infers search, question, action or correction.
  
2. **Search.** Instant results while typing. {==Events, spaces, people, tasks.==}{>>claims, episodes, etc<<}{id="c101" by="user" at="2026-09-04T21:02:32.066Z"}
  
3. **Chat.** Every answer cites events. Tap a citation to land on the timeline. {==No ground, no answer.==}{>>it should not be no answer, but answer can be given from the model CLI adapter. if the question relates to anything from user's data then it should be in english with supporting evidence<<}{id="c102" by="user" at="2026-09-04T21:03:01.895Z"}
  
4. **New task.** "Remind Rohan about the advance" becomes a normal task with normal risk rules.
  
5. **New space.** "Plan Hampi trek in October" creates a space and sweeps related history in.
  
6. Threads are events too. Searchable, resumable.
  
### 16.2 Personality
1. Warm, brief, direct. Speaks the user's language mix.
  
2. Shows its reasoning in one line. Never lectures.
  
3. Admits gaps. "Nothing in your data about this."
  
4. Adapts register to the surface: terse in the menu bar, fuller in the space view, casual on WhatsApp.
  
5. {==Has opinions when asked. Says "I'd pick Villa Sol" and why.==}{>>opinion based on what? it should be based on user's preferences, right?<<}{id="c104" by="user" at="2026-09-04T21:07:25.579Z"}
  
### 16.3 Reactions, emoji, stickers, GIFs
1. When a reaction is enough, react. 👍 to "done". ✅ to an approval. 🎉 to a booked trip.
  
2. Emoji and stickers are valid replies on chat surfaces.
  
3. {==GIFs and stickers match the user's own habits with that person or group.==}{>>what has grounded chat / grounded search replies got to do with "with that person or group"? there are no other person or group involved in grounded chat / grounded search. what am i missing? The issue will be a lot of product/services if we try to run on server will get blocked - like whatsapp, instagram, x, etc . We might have to take residential IP with the VPS. all this might increase the costs significantly that the user would have to pay<<}{id="c105" by="user" at="2026-09-05T00:20:19.227Z"}
  
4. Text and reaction together are fine. Never a paragraph where a 👍 would do.
  

* * *
## 17. Apps surface and devices
```
                    ┌──────────────────┐
                    │   HOME SERVER    │  24x7 · all data · local models · public twin host
                    └───┬──────┬───┬───┘
          encrypted sync│      │   │
              ┌─────────┘      │   └─────────┐
              ▼                ▼             ▼
        ┌──────────┐    ┌──────────┐   ┌──────────┐
        │   MAC    │    │  PHONE   │◄──│ PORTABLE │
        │ menu bar │    │ capture  │   │ mic·cam  │
        │ main win │    │ approve  │   │ button   │
        └──────────┘    └──────────┘   └──────────┘
              ▲                ▲
              └── WhatsApp · iMessage · Mail (twin's own number/address)
```
### 17.1 Desktop and menu bar
1. Mac app, always resident. Menu bar icon shows capture and attention state.
  
2. {==Main window on a global hotkey. Home, Spaces, Tasks, People, Timeline, Library, Settings.==}{>>nudges should also be visible inside app<<}{id="c109" by="user" at="2026-09-05T01:06:17.387Z"}
  
3. {==Grounded bar floats over everything.==}{>>both inside app window and outside<<}{id="c107" by="user" at="2026-09-05T01:02:05.862Z"}
  
### 17.2 Mobile app
1. Capture: screenshots, share sheet, voice, ambient voice, clipboard, {==keyboard==}{>>keyboard and voice input keyboard<<}{id="c108" by="user" at="2026-09-05T01:04:02.109Z"}, location.
  
2. {==Surface: today list, nudges, approvals, chat, spaces.==}{>>tasks, people missing<<}{id="c110" by="user" at="2026-09-05T01:06:36.788Z"}
  
3. Approvals on the phone approve tasks running on the Mac or server.
  
4. Local storage with encrypted sync.
  
### 17.3 WhatsApp, iMessage, Mail
1. {==The twin has its own number and address. Message it like a person.==}{>>the only way to do this would be have our business number for whatsapp and imessage. But then it would no longer be private as these would be our numbers not the user's. And every user wont be able to get another phone number and do all the setup to enable this. How do we do this feature while maintaining our position as private?<<}{id="c111" by="user" at="2026-09-05T01:07:34.083Z"}
  
2. Send a forward, a voice note, a photo, a question, or an order.
  
3. It replies in the same channel with text, reactions, stickers or a link to a card.
  
4. Approvals can be answered by reply. Risky steps still need the app's approval token.
  
### 17.4 Portable AI device
1. Small, always with you: mic, camera, button. No screen needed.
  
2. Captures ambient voice and photos. Answers by voice through earbuds.
  
3. Syncs to the phone. Same memory, same twin.
  
### 17.5 {==Home AI server==}{>>Can we also do a cloud server based setup where people can pick their own cloud provider and/or somehow we do a simple one click setup, and not host on our servers and not store any user data on our servers?<<}{id="c106" by="user" at="2026-09-05T00:30:10.076Z"}
1. A box at home that runs the twin 24x7, holds all data, runs local models.
  
2. Phone, Mac and device sync to it. The Mac can sleep.
  
3. Hosts the public twin without exposing raw data.
  
4. Optional. Solo mode works with the Mac alone.
  

* * *
## 18. Collaboration
### 18.1 Shared and collaborative spaces and tasks
1. {==A space can be shared with people who have a SuperTwin ID. A trip, a wedding, a project, a flat.==}{>>if the other person does not has a supertwin id, they can be invited to create one by the user who has. this acts as growth mechanism and provides network effects<<}{id="c112" by="user" at="2026-09-05T01:12:02.888Z"}
  
2. {==Share scope per share: plan only, tasks, artifacts, or evidence too. Evidence off by default.==}{>>only shared evidence and public evidence should be shared. most of the other items should be shared. goal, plan, tasks, results, etc for a shared space . let me know if there is any privacy issue<<}{id="c113" by="user" at="2026-09-05T01:14:02.392Z"}
  
3. Tasks in a shared space have owners across users. Each twin holds its owner's tasks.
  
4. Single-player spaces stay single-player unless shared. Sharing is reversible.
  
5. Changes sync through encrypted messages between twins. No central store.
  
### 18.2 Twin-to-twin communication
```
  Aditya's twin                              Rohan's twin
       │  "dinner Sat or Sun? budget?"            │
       │ ────────────────────────────────────────►│  checks: free-busy · prefs · budget scope
       │◄──────────────────────────────────────── │  "Sat 8pm · ≤₹1.5k pp · no seafood"
       │  proposes 3 places                       │
       │ ────────────────────────────────────────►│
       │◄──────────────────────────────────────── │  "Toit works"
       ▼                                          ▼
   card to Aditya: "Sat 8pm, Toit,           card to Rohan
   Rohan's twin agreed" [Confirm] [Change]   [Confirm] [Change]
```

1. Twins settle coordination: find a time, split a bill, pick a place, confirm a plan.
  
2. Each twin speaks only for what its owner has allowed: {==free-busy, preferences, budget range==}{>>not limited to only these i am assuming. there can be many more depending on the task.<<}{id="c114" by="user" at="2026-09-05T01:18:27.264Z"}.
  
3. The result comes back as one card. "Rohan's twin says Sat works, budget ₹6k, no seafood."
  
4. Anything binding needs both owners to approve. {==Twins negotiate.==}{>>negotiate and discuss<<}{id="c115" by="user" at="2026-09-05T01:20:25.473Z"} Humans commit.
  
5. Twin messages are signed events. Both sides see the log.
  

* * *
## 19. Broadcast and public
### 19.1 Public spaces
1. {==A space can be made public: a reading list, a travel log, a project, a portfolio, a recipe collection==}{>>recommendations of various kinds are key spaces to be made public. collection / research on certain topic as well. of course these can be shared with limited people as well, not just made fully public<<}{id="c116" by="user" at="2026-09-05T01:21:06.728Z"}.
  
2. Public spaces show curated content only. Never evidence, never private people.
  
3. The twin drafts posts and updates from the space. The user approves each one.
  
4. Private is the default. Public is one explicit switch per space, with a preview.
  
### 19.2 Follow spaces
1. Anyone can follow a public space. Followers get updates in their own twin.
  
2. A followed space can feed a follower's private space. A friend's Goa list seeds your Goa trip.
  
3. Follows are consent on both sides. Blocking is one tap.
  
### 19.3 Twin-to-public-twin communication
```
  visitor ─► "What does Aditya recommend in Goa?" ─► Aditya's PUBLIC twin
                                                          │
                                          answer from public spaces only, with sources
                                                          │
                                          needs the owner? ─► task for Aditya's private twin
```

1. A public twin answers on the owner's behalf within what is public.
  
2. Requests that need the owner become a task for the private twin.
  
3. The owner sees every public conversation. Rate limits and blocklists apply.
  
4. A public twin has a link. "Ask my twin." Works from a bio, a card, a mail signature.
  

* * *
## 20. UI and UX
{==Design language: translucent glass, one type scale, one card anatomy. Every object has a header, a body, an evidence strip and a three-item menu.==}{>>translucent glass base over a live (animated / moving) )background that reflects time of the day, the city (some unique/iconic building in the image) and weather. dont know how it can be generated dynamically and differently for different users. Also the app should be full screen (if it can be full screen that appears and disappears like an overlay on desktop that would be the most ideal animation/experience) by default, not windowed<<}{id="c117" by="user" at="2026-09-05T01:31:19.001Z"}
### 20.1 Onboarding
```
 ┌────────────────────────────────────────────────────────────────────┐
 │  Connect a source                                    step 2 of 4   │
 │                                                                    │
 │  ┌ WhatsApp ─────┐ ┌ Browser ──────┐ ┌ Screen ───────┐              │
 │  │ chats, media  │ │ history, tabs │ │ what you see  │              │
 │  │ never: status │ │ never: incog. │ │ never: passw. │              │
 │  │ [ Connect ]   │ │ [ Connect ]   │ │ [ Connect ]   │              │
 │  └───────────────┘ └───────────────┘ └───────────────┘              │
 │  ┌ Mail ─────────┐ ┌ Calendar ─────┐ ┌ Notes ────────┐  + 14 more   │
 │                                                                    │
 │  ── WhatsApp ───────────────────────────────────────────────────── │
 │  Index      [ everything ▾ ]   38,412 messages · 210 MB   exact    │
 │  Understand [ 30 days ▾ ]       1,204 messages · ~30¢ · ~4 min      │
 │  We stop and ask if cost passes $2.                                │
 │                            [ Skip for now ]   [ Confirm & start ]  │
 └────────────────────────────────────────────────────────────────────┘
```
### 20.2 Home
```
 ┌────────────────────── ⌂ Home  ▤ Spaces  ☑ Tasks  ◙ People  ◷ Timeline  ⚙ ──────────────────────┐
 │                                                                                                   │
 │ ┌─ Needs you ───────────────────────┐  ┌─ Spaces ────────────────────────────────────────────┐  │
 │ │ ▸ Approve flights CCU-GOI ₹18,340  │  │ ● Goa trip with Rohan · Dec   Flights ✓ Stay ◐ · 3  │  │
 │ │ ▸ Q: cab from home or office?      │  │ ● Diwali gifts for family     2 tasks · Tanvi Ma    │  │
 │ │ ▸ Pay Diwali pool · due today      │  │ ● v13 launch                  4 tasks · Sameer      │  │
 │ └───────────────────────────────────┘  │ ○ Gym restart (dormant)                              │  │
 │ ┌─ Prepared for you ────────────────┐  └──────────────────────────────────────────────────────┘  │
 │ │ ◆● Villa comparison — 3 fit budget │  ┌─ People ─────────────┐ ┌─ Recent understanding ─────┐  │
 │ │ ◇  Draft reply to Sameer           │  │ Ma · birthday in 12d │ │ + Rohan prefers aisle seats│  │
 │ │ ◇  Web check-in done               │  │ Sameer · you owe reply│ │ + Trip budget ₹6k/night   │  │
 │ └───────────────────────────────────┘  └──────────────────────┘ └────────────────────────────┘  │
 │                                                                                                   │
 │                 ┌───────────────────────────────────────────────────────┐                        │
 │                 │ ⌕  Ask, search, or tell me to do something          ↑ │                        │
 │                 └───────────────────────────────────────────────────────┘                        │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```
### 20.3 Space view
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ Goa trip with Rohan ✎         active · one-time · Travel · shared 3 │
 │ Goal: 4 people, 18–21 Dec, under ₹20k pp                            │
 │                                                                    │
 │ milestones   Flights ✓ ──── Stay ◐ 2 tasks ──── Day trips ○         │
 │ ◆ Villa comparison ready — 3 fit budget · open                     │
 │ ┌─ Stay ─────────────────────────────────────────────────────────┐ │
 │ │ ▸ Book villa                       ● executing · step 3/5      │ │
 │ │ ▸ Collect ₹5k advance from Karan   due Sep 2 · Karan's twin ✓  │ │
 │ └────────────────────────────────────────────────────────────────┘ │
 │ pinned       budget ₹6k/night · 4 people · 18→21 Dec               │
 │ people       Rohan · Tanvi · Karan                                 │
 │ enrichment   fares today ₹4.8–5.6k · weather 29°C sunny            │
 │ next         lock villa → pay pool → cabs                          │
 │ evidence     ▂▃▅▂▃  WhatsApp · browser · screen                    │
 │                                          why? · trace · ··· share  │
 └────────────────────────────────────────────────────────────────────┘
```
### 20.4 Prioritized task list
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ Tasks             [ all areas ▾ ] [ person ▾ ] [ type ▾ ]           │
 │ NEEDS YOU                                                          │
 │ ▸ Approve flights ₹18,340        Goa trip      [ View ] [ ✓ ]      │
 │ ▸ Cab from home or office?       Goa trip      [ home ] [ office ] │
 │ TODAY                                                              │
 │ ▸ Pay Diwali pool                Family        due 6pm  ● prepared │
 │ ▸ Reply to Sameer                Work          draft ready         │
 │ THIS WEEK                                                          │
 │ ▸ Collect advance from Karan     Goa trip      Sep 2               │
 │ ▸ Renew car insurance            Admin         Sep 6   ○ research  │
 │ WAITING ON OTHERS                                                  │
 │ ▸ Rohan: share flight link       Goa trip      asked Tue           │
 └────────────────────────────────────────────────────────────────────┘
```
### 20.5 Person card
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ ◙ Rohan Mehta                  ⦿ close friends · twin: @rohan ✓     │
 │ claims    prefers aisle seats · not vegetarian · runs on Sundays   │
 │ tone      Hinglish, short, 🔥-heavy — used for drafts              │
 │ shared    ● Goa trip · ● Diwali gifts                              │
 │ loops     owes villa advance ₹5k · birthday in 12 days             │
 │ recent    WhatsApp 2h ago · split PDF on screen, Tue               │
 │ their goals  marathon in Jan (from his public space)               │
 └────────────────────────────────────────────────────────────────────┘
```
### 20.6 Menu bar and nudge
```
 ┌─ SuperTwin ──────────────────── ● rec ⏸ ▾ ─┐   ┌─ nudge (top-right) ───────────────┐
 │ NEEDS YOU                                  │   │ ◆ Goa trip › Stay                 │
 │ ▸ Approve flights ₹18,340     [view] [✓]   │   │ Saw you comparing Anjuna villas.  │
 │ ▸ Q: cab?                  [home][office]  │   │ Compared 6 across 3 sites.        │
 │ PREPARED                                   │   │ 3 fit ₹6k/night.                  │
 │ ◆● Villa comparison            2:41pm      │   │ ┌───────────────────────────────┐ │
 │ ◇ Draft reply to Sameer        11:20am     │   │ │ Villa Sol ₹5.4k ★4.8 · pool   │ │
 │ TODAY  pool due 6pm · check-in fires 7am   │   │ │ + 2 more                      │ │
 │ ─────────────────────────────────────────  │   │ └───────────────────────────────┘ │
 │ ⌕ ask…      forget last 10 min   open ⌘⇧S  │   │      [ Open ]    [ Not now ]   ✕  │
 └────────────────────────────────────────────┘   └───────────────────────────────────┘
```
### 20.7 Grounded bar
```
 ① collapsed   ┌ ⌕ Ask, search, or tell me to do something ↑ ┐
 ② typing      ┌ ⌕ goa vill▌                                 ┐
               │  ▸ 12 events · ▸ Goa trip › Stay             │
 ③ answer      │ you: how much per night?                     │
               │ twin: ₹6k max — you, Aug 24 ¹ · Rohan ²      │
               │ ¹ ❝max 6k a night yaar❞  ² ❝under 20k pp❞    │
 ④ acting      │ you: remind rohan about the advance          │
               │ twin: ❝bhai villa advance ₹5k…❞  ✎           │
               │ [ Send (approve) ] [ Change ] [ Cancel ]     │
 ⑤ locked      │ ⊙ task: Book villa  ✕                        │
               │ you: this is karan's, not mine → moved ✓ undo│
 ⑥ history     │ ▸ villa advance · ▸ hampi trek · ▸ per night │
```
### 20.8 Mobile
```
 ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
 │ Today            │   │ Approve          │   │ 🎤 hold to talk  │
 │ ● Approve ₹18,340│   │ Pay ₹18,340      │   │ "add milk to the │
 │ ● Q: cab?        │   │ IndiGo · 4 pax   │   │  grocery space"  │
 │ ○ Pay pool 6pm   │   │ free cancel Sep15│   │                  │
 │ ◆ Villa compare  │   │ criteria 5/5 ✓   │   │ ✓ added · 👍     │
 │ ─────────────    │   │ [ Approve ]      │   │                  │
 │ ⌕ ask  📷  🎤  📎 │   │ [ Change ] [ ✕ ] │   │ ⌕ ask  📷  🎤  📎 │
 └──────────────────┘   └──────────────────┘   └──────────────────┘
```
### 20.9 WhatsApp channel
```
  You:   [forwarded] "Anjuna villa ₹5.4k, pool, 6 beds"
  Twin:  👍 added to Goa trip › Stay. It's the cheapest of your 3.
  You:   book it
  Twin:  Ready to book. ₹16,200 for 3 nights, free cancel till Dec 1.
         Approve in app → supertwin://approve/8f2c
  You:   ✅
  Twin:  That's a reply, not a tap 🙂 — the app needs your tap for money.
```
### 20.10 Public space page
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ @aditya · Goa recommendations                        Follow · Ask  │
 │ 14 places · updated 3 days ago                                     │
 │ ▸ Gunpowder, Assagao — "best pork vindaloo, go early"              │
 │ ▸ Villa Sol, Anjuna — "pool, 6 beds, ₹5.4k in Dec"                 │
 │ ▸ Morjim beach at sunrise                                          │
 │ ──────────────────────────────────────────────────────────────────  │
 │ Ask Aditya's twin:  ⌕ "good for a family of 5?"                     │
 └────────────────────────────────────────────────────────────────────┘
```

* * *
## 21. Architecture
```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ SURFACES      Tauri app · menu bar · mobile · chat channels · public │
 ├──────────────────────────────────────────────────────────────────────┤
 │ SERVICES      grounded bar · assist · executor · scheduler · sync    │
 ├──────────────────────────────────────────────────────────────────────┤
 │ UNDERSTAND    packer · orient · critic · extract · decide · digest   │
 ├──────────────────────────────────────────────────────────────────────┤
 │ MEMORY        event log · FTS · embeddings · world model · traces    │
 ├──────────────────────────────────────────────────────────────────────┤
 │ CAPTURE       adapters · filter · consent gate · browser · computer  │
 ├──────────────────────────────────────────────────────────────────────┤
 │ BRAIN         AI connector · model roles · spend rails · skills      │
 ├──────────────────────────────────────────────────────────────────────┤
 │ TRUST         keypair · approval tokens · twin protocol · audit log  │
 └──────────────────────────────────────────────────────────────────────┘
```

1. **One worker process** owns the log, the lanes and the services. The UI only renders and emits events.
  
2. **Adapters are plugins.** One contract: enumerate, count, backfill, live, filter. A new source is one adapter.
  
3. **Passes are single-shot.** Prompt in, JSON out. Agents run only where a human waits or on schedule.
  
4. **Every model call has a trace.** Prompt, context, output, cost. Visible in the app.
  
5. **Sync is message-based.** Devices and twins exchange signed, encrypted events. No central store.
  

* * *
## 22. System design
### 22.1 Event envelope
```
 event {
   id · ts · source · kind · origin live|backfill · stream_key
   actor · roles { sender, audience[], receiver[], mentions[] }
   payload (typed) · content_hash · blob_refs[] · consent_id
 }
```
### 22.2 Two lanes
```
  LIVE LANE          idle 45 s / max 2 min / ~20k chars   →  understanding + assist in ONE call
  BACKFILL LANE      one calendar day per call, newest first  →  understanding only, never nudges
  reserved concurrency for live · backfill can never queue a nudge
```
### 22.3 {==Understanding passes==}{>>assist should not be separate path i feel, because it might lack a lot of context. what is the benefit of having it separately? why should orient, critic, decide, execute etc not be the same passes? how does a separate assist pass help?<<}{id="c119" by="user" at="2026-09-05T01:41:21.681Z"}
| Pass | Unit | Output |
| --- | --- | --- |
| Orient | one bundle | episodes, filing, proposals, unsorted, questions |
| Critic | Orient's writes | commit, reject, downgrade, flag |
| Extract | committed episodes | claims, people, tone |
| Decide | one space | milestones, tasks, schedules, closures, follow-ups, plan |
| Digest | {==one low-signal stream, one month==}{>>one month seems awfully long time window. not sure what we are achieving by this.<<}{id="c118" by="user" at="2026-09-05T01:40:31.515Z"} | summary, claims, recurrences |
| Assist | live bundle | intent, confidence, one prepared action |
### 22.4 {==Retrieval==}{>>how is retrieval going to work exactly? what are we using to retrieve? and what is it going to retrieve? and how will it be used and where / by whom?<<}{id="c121" by="user" at="2026-09-05T01:45:43.586Z"}
1. Full-text recall, top ~2,000.
  
2. {==Cosine rerank on those only.==}{>>reranking needs to be better, just cosine is weak.<<}{id="c120" by="user" at="2026-09-05T01:45:11.732Z"}
  
3. Neighbourhood expansion by stream, bridge and entity.
  
4. Cite by event id.
  
### 22.5 Safety invariants
1. No adapter reads before its consent record exists.
  
2. Risky actions require a single-use signed token minted by a user tap.
  
3. Spend and call ceilings throw before the model is called.
  
4. A bundle is attempted at most 3 times, then dead-lettered and shown.
  
5. Deleting a source cascades to everything derived from it.
  
6. Backfill output never reaches the nudge surface.
  
7. Public twins read only from public spaces. Enforced by a separate store.
  
### 22.6 Twin protocol
1. Message: `{ from_key, to_key, thread, intent, scope[], body, sig }`.
  
2. Scopes: free-busy, preferences, budget, plan, tasks, artifacts, evidence.
  
3. Each twin answers only within granted scopes. Everything else returns "ask my owner".
  
4. Transport: relay servers that hold only ciphertext. Any relay works.
  

* * *
## 23. Step by step: how the system runs
Worked example. Rohan writes "guys lets lock goa 18-21 dec" in the Goa gang group. The user then opens Airbnb.

```
  1  CAPTURE     WhatsApp adapter emits event e1. Consent ok. Filter ok. Written to log.
  2  ARCHIVE     FTS indexed. Chunk embedded. Stream: wa:goa-gang.
  3  BUNDLE      Live lane waits 45 s idle. Bundle = e1 + 12 replies + 3 browser visits.
  4  PACK        Roster, thread history, open episodes, candidate spaces, open tasks, time.
  5  ORIENT      Episode "dates locked 18–21 Dec" → join space "Goa trip with Rohan".
  6  CRITIC      Evidence quote matches. Commit.
  7  EXTRACT     Claim: trip dates 18–21 Dec. Rohan: will share flight link.
  8  DECIDE      Task "Book flights CCU-GOI" · approve-final · due Aug 29.
                 Schedule: web check-in T-48h. Plan: flights → stay → cabs.
  9  ASSIST      Same call. User is on Airbnb. Intent: comparing villas. Confidence 0.9.
 10  PREPARE     Executor-lite compares 6 villas across 3 sites. Auto class. Artifact built.
 11  NUDGE       Card top-right. Prepared shelf. Space banner. Bar chip. One status.
 12  EXECUTE     User opens "Book flights". Executor plans, compares, fills up to payment.
 13  APPROVE     Approval card. User taps. Token minted. Payment step runs in WebView.
 14  FOLLOW-UP   "Flights booked ✓" → propose "web check-in" (scheduled) and "cab".
 15  LEARN       User edits cab task title. Correction event. Eval case drafted.
 16  MEMORY      Trip closes in December. Preferences, people, patterns updated.
```

Timing: steps 1–11 finish within 2 minutes of Rohan's message.

* * *
## 24. {==Settings the user sees==}{>>Settings and configurable options in existing V13 should also be included. some are missing.<<}{id="c122" by="user" at="2026-09-05T04:47:10.038Z"}
1. Per source: connect, pause, disconnect, delete, index window, understand window.
  
2. Data filters: apps, sites, chats, senders, folders, time rules, never-list.
  
3. AI connector: doors, model roles, reasoning level, spend ceilings, stop-all switch.
  
4. Assist: sensitivity, quiet hours, muted contexts, popups on or off.
  
5. Identity: profile card, voice, SuperTwin ID, devices, keypair backup.
  
6. Sharing: shared spaces, public spaces, followers, blocklist, twin scopes.
  
7. Runs: traces, costs, quarantine, undo log.
  

* * *
## 25. Phasing
| Phase | Name | Ships |
| --- | --- | --- |
| P1  | Solo Mac | Onboarding, CLI adapter, WhatsApp, browser, screen, memory, spaces, tasks, grounded bar, nudges, feedback |
| P2  | More inputs | Mail, calendar, notes, clipboard, screenshot, voice input, Mouse Helper, scratchpad, executor with browser, generative UI |
| P3  | Everywhere | Mobile app, WhatsApp and iMessage channels, OAuth and OpenRouter doors, commerce and social sources, computer control |
| P4  | Together | SuperTwin ID, shared spaces, twin-to-twin, home server sync |
| P5  | Public | Public spaces, follows, public twin, portable device |

* * *
## 26. Non-goals
1. No cloud copy of raw data. Ever.
  
2. No autonomous payments, sends or bookings. The last step is always the user's.
  
3. No scraping with private-API libraries on real accounts.
  
4. No feed. The twin surfaces work, not content.
  
5. No ads. No selling data. The user pays for the model. We charge for the twin.
  

* * *
## 27. Open questions
1. {==Ambient voice on by default for the portable device, or opt-in per session?==}{>>ambient voice should be on by default on all devices. on desktop and mobile as well. Of course we would have to take permission. and option to turn off should be very simply - a key press on desktop (apart from within the app) - both visible from grounded bar and menu bar, from live activity notification in iphone but also inside app.<<}{id="c123" by="user" at="2026-09-05T04:48:58.861Z"}
  
2. {==Should a public twin be able to accept bookings or orders on the owner's behalf?==}{>>Depends on what the user allows. user can allow different things for different public spaces.<<}{id="c124" by="user" at="2026-09-05T04:51:57.806Z"}
  
3. {==How much of a shared space does a departing member keep?==}{>>what does a departing member mean here? leaving the platform? because user cannot take their data with them in the current design when they leave.<<}{id="c125" by="user" at="2026-09-05T04:52:38.684Z"}
  
4. {==Which relay runs twin-to-twin by default, and who pays for it?==}{>>whats a relay? and both twins can either share costs or the twin which initiates a conversation/task can pay. we should keep this architecture such that either party can pay or both can share.<<}{id="c126" by="user" at="2026-09-05T04:53:43.985Z"}
  

* * *
## 28. {==Glossary==}{>>There are many other terms which are missing in the glossary.<<}{id="c127" by="user" at="2026-09-05T04:56:31.742Z"}
1. **Event.** One captured thing. Immutable.
  
2. **Stream.** Where events happen: a chat, an app session, a domain day.
  
3. **Bundle.** A few minutes of life across all sources. The unit of a model call.
  
4. **Episode.** One burst of activity about one thing in one stream.
  
5. **Space.** One goal. Holds milestones, tasks, plan, people, claims, evidence.
  
6. **Milestone.** A dated sub-goal inside a space.
  
7. **Task.** One actionable item with a type, a risk class and an owner.
  
8. **Claim.** One structured statement about a person, with evidence and validity.
  
9. **Nudge.** A proactive card: intent, what I did, artifact.
  
10. **Prepared.** Finished work waiting for the user.
  
11. **Risky step.** Pay, send, book, delete, change an account. Always last. Always the user's.
  
12. **SuperTwin ID.** Public key plus handle. Needed for Together and Public.
  
13. **Twin protocol.** Signed, scoped, encrypted messages between twins.
  
14. **Trace.** The record of one model call. Prompt, context, output, cost.
