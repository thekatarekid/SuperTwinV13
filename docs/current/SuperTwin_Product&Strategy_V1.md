# SuperTwin — Product & Strategy V1
SuperTwin is your AI twin. It observes and remembers everything about you, finds what needs doing now and in advance, does it the way you would before you ask, stands for you to other people and to their agents, and turns what you consume into taste that others can draw on.

This document is the product and strategy of record as of September 15, 2026. It is complete on its own: everything kept from earlier product versions is written out here in full, and nothing requires the older documents. Where it disagrees with any older document, this one wins. It does not describe the current code; it describes the product and how it works.

Terms are defined in bold the first time they are used. A glossary at the end collects them.

**Contents**

- Part A, Strategy: §0 Summary · §1 Market · §2 Strategy
  
- Part B, Product: §3 Vision and principles · §4 Users · §5 Messaging · §6 Product map and UX map · §7 The twin · §8 Identity · §9 Onboarding · §10 Brain · §11 Capture and storage · §12 Understanding · §13 Execution · §14 Live mode · §15 Feedback and learning · §16 Grounded bar and personality · §17 Communication · §18 Taste · §19 Network · §20 Public · §21 Collectives · §22 Economy and business model · §23 Apps and devices
  
- Part C, System: §24 UI and screens · §25 Architecture · §26 System design · §27 Step by step · §28 Settings
  
- Part D, Plan: §29 Growth · §30 Execution plan · §31 Metrics · §32 Non-goals · §33 Open questions · §34 Risks · §35 Glossary
  

* * *
# Part A — Strategy
## 0. Summary
1. The personal agent market is crowded and funded: Meta Muse, Instinct, Town, Grok Bot, Perplexity Computer, Poke, Yutori, and the labs. Every feature we specify can be copied by any of them within a quarter. Data pulled from a user's own accounts can be rebuilt by any competitor in minutes. Business models, including paying the user, can be copied the moment they work.
  
2. {==What cannot be copied is a position incompatible with what a competitor is. SuperTwin takes four: **open** (published protocol, open node, open skill ecosystem, where every competitor is a walled garden), **local** (runs on the user's devices and own cloud with user-held keys, where every competitor is a cloud computer), **neutral** (not a seller, ad network, model lab or platform owner, so it works with every assistant, store, model and counterparty and takes the user's side), and **everywhere** (every OS, channel, language and country, including those each competitor excludes).==}{>>only open and local are positions which are slightly incompatible for competitors, not entirely though. They can still do it. Neutral (we would also not be neutral maybe) and everywhere are very much compatible.<<}{id="c1" by="user" at="2026-09-15T16:24:47.986Z"}
  
3. {==This is the Android strategy against a field of iPhones. Closed networks are won by whoever has the most users, which will never be us. The open network is the only one a small company can win, and it wins on volume, long tail, and being everywhere.==}{>>this is true, but we should not assume that bigger companies cannot or will not create open networks<<}{id="c2" by="user" at="2026-09-15T16:37:28.541Z"}
  
4. Copying a feature does not transfer four assets that compound per user: **tenure** of data nobody else captures and nobody can re-sync later; {==the **master address** others use to reach the person and the twin==}{>>unless the master address is on an open protocol and other competitors also adopt that open protocol. (It's similar to Payment wallets like paytm wallet versus UPI for peer to peer payment)<<}{id="c3" by="user" at="2026-09-15T16:38:24.545Z"}; the **dependence** of family and groups whose plans, money and safety run through the twins; and the {==**skills and behavioural rules** the twin authored for this person's specific sites, apps and people==}{>>only if the skills and behavioural rules are not portable<<}{id="c4" by="user" at="2026-09-15T16:40:47.665Z"}.
  
5. The single-player assistant is the ticket to play, not the game. It must reach parity with Instinct and Muse on connectors, proactive execution, conversational interface, calls, email and a trusted network, {==and add what they lack==}{>>proper app with UI / UX made for the specific task, not generic. Artifacts for tasks can also solve this to some extent, but not entirely. Ideally each space should have unique UI UX meant for that particular subject or goal. The live mode is also something that they lack.<<}{id="c6" by="user" at="2026-09-15T16:45:16.805Z"}: visible traces, {==parallel tasks in spaces instead of one noisy thread==}{>>parallel tasks in spaces and parallel spaces - both are better organization of parallel execution. organization of user's life in spaces (which are essentially goal focussed channels)<<}{id="c5" by="user" at="2026-09-15T16:41:55.326Z"}, evidence on every claim, and the proof surface.
  
6. {==**Live mode**, the highly proactive help on the desktop==}{>>This help should also be available on other surfaces like Live activities notification on mobile, Maybe these can also be sent as WhatsApp messages or mobile app notifications. Ofcourse sending via 3 ways on mobile is overkill. We should send via the one best way - which most likely would be live activities because its always on top of other notifications and will also be used for ambient voice recording on mobile.<<}{id="c7" by="user" at="2026-09-15T16:48:44.251Z"} that acts on what the user is doing within a minute and shows finished work as a card, is the sharpest product differentiator in the market today. It is copyable, and it is still the thing no shipping product does, because every competitor is told what to do.
  
7. The highest-frequency surface we can own is communication: messages, calls, group chats, follow-ups. The highest-frequency activity on a phone is content consumption and forwarding, which produces no outcome for the consumer. The twin turns consumption into **taste**: an asset the owner keeps, gives, takes and earns from, with social capital measured in draws, adoptions and firsts rather than likes.
  
8. The twin is an identity: a master address covering every public-facing handle, a **SuperTwin ID** keypair that signs every message, call and approval, a stylized **face** and declared **voice**, a **card** others see, an **inbound gate** that decides who and what may reach the person, a **ledger** of everything the twin did, and a **life story** written from evidence.
  
9. The network is an open protocol between twins, with twin-to-human coordination over the twin's own email and phone number so it works with people who have nothing, and interop with other assistants over the same channels because none of them will offer an API.
  
10. **Collectives** are groups of twins with a shared objective acting together: buyers negotiating volume prices by outreach, residents pooling orders, fans organizing, citizens filing grievances. They need no partnerships, only twins that can email, message and call sellers on behalf of many.
  
11. Money: understanding is nearly free on DeepSeek-class models and is paid by us for everyone. Execution is metered with a free allowance, paid tiers, and bring-your-own keys or subscriptions unmetered. {==Later, the **task market** lets business twins pay to respond to a user's task with most of the money going to the user: your tasks earn you money. Creators earn from taste subscriptions. We never sell ads==}{>>Use or their twin can also post a task on the market offering certain money or asking for quotes. Other user twins, including brand/company twins can do those tasks and get the money. This approach is the more conventional kind of task marketplace, apart from the one you already mentioned where users are able to get money for their own tasks.<<}{id="c8" by="user" at="2026-09-16T00:51:19.605Z"}.
  
12. Growth without money: creator twins, twin-made content that users post to their existing networks, every twin action signed and visible to the people it touches, the developer ecosystem through open skills and an MCP server that exposes the twin's memory to other agents, and build-in-public. Then product-led loops through groups, families, verified safety, and the twin doing the inviting.
  
13. {==Execution runs in three phases, each ending in a release in real users' hands, on a cadence measured in days==}{>>there can be multiple user ready releases within a phase as well.<<}{id="c9" by="user" at="2026-09-16T00:56:12.060Z"}.
  
## 1. The market as of September 2026
### 1.1 Who is building what
| Company | What it is | Runs where | Price | Open | Multi-player | Observes or is told | The gap from our seat |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Instinct | Personal agent you text or call on iMessage, WhatsApp, phone. Persistent cloud computer with cached credentials. Email address per assistant since Sept 9. Instinct-to-Instinct trusted person network since Sept 11. Action button on iPhone. Aggressive autonomy. | Its cloud | Free beta, expected $50+ | Closed | Closed network, Instinct only | Told, plus screen, audio, location per its terms | Cloud only, US and English only, one noisy thread, no visible traces, memory that weakens explicit instructions and invents execution history, perpetual data license |
| Town | "Townies" for work: email, calendar, Slack, docs, WhatsApp, desktop. @town.com address. Free plan with 30 chats, credits above. | Its cloud | Free tier, credits | Closed | No  | Watches connected accounts | Prosumer work tool, US, no phone life, no network |
| Meta Muse | Personal agent on iOS, Android, web, WhatsApp, glasses soon. Secure VM per user, Sentinel that inspects every outbound action, Stripe Link single-use cards, memory files, goals view, scheduled and event-driven background work, Muse Spark 1.3. | Meta's cloud | Free 100M tokens a week, $20, $100 | Closed | Will be Meta only | Told | US only, Meta trust deficit, late to the EU every time, cannot capture what its own ephemeral features hide, will never federate |
| Grok Bot | Always-on agents on a cloud PC, work-oriented | Its cloud | $120 a month | Closed | No  | Told | Price, work focus |
| Perplexity Computer | Agentic desktop on Mac and Windows, routes across many models, a Portable Computer variant with local models | User's machine plus cloud | $200 tier | Closed | No  | Told, files and apps | Work and research focus, no identity, no network, no phone life |
| Poke, now Cognition | Proactive assistant on iMessage, WhatsApp, Telegram, RCS with strong personality | Its cloud | Subscription | Closed | No  | Told | Acquired for personality, single-player |
| Yutori | Scouts that monitor the web and do web chores | Its cloud | Subscription | Closed | No  | Told | Narrow |
| ChatGPT and Pulse, Gemini, Claude Cowork, Siri AI, Meta AI, Manus | Lab generalists; Pulse is a nightly proactive brief; Siri AI has on-device personal context and on-screen awareness | Cloud, Siri on device | $20 tier, Siri free | Closed | No  | Told, Siri observes on device | Single-player, walled, none reads another's memory, Apple excludes Android |
| OpenClaw, Hermes | Open-source agents with community skills, self-hosted, many messaging platforms | User's machine | Free | Open | No  | Told | Developer products, no consumer app, no identity, no phone presence |
| minimi | Desktop assistant that keeps personal context local and separate from the model, sends each task only the context it needs, ambient screen and voice capture only, its own model APIs, subscription managed on its server | User's desktop plus its APIs | Subscription | Closed | No  | Observes screen and voice | Desktop only, no network, not the most private positioning possible, too small to matter; its context-separate-from-model framing is one we share |
| Truecaller, Equal, hiRobin | Call identification and AI call screening; Truecaller has hundreds of millions of Indian users and an assistant, Equal has a million monthly users | Cloud | Free, premium | Closed | No  | Calls only | Calls only, no memory of the rest of life, no action after the call |
| Faff, Swiggy Crew, Hulp, Pinch, Kookar | Human or hybrid concierges on WhatsApp in India | Humans | ₹999 to ₹1,999 | Closed | No  | Told | Cost grows with every user, cannot be free, cannot be everywhere |
| Magic, Athena, Wing, Belay, Time etc, Get Friday, luxury concierges | Human assistants and premium concierge | Humans | Premium | Closed | No  | Told | Same |
| Lindy, Glean, M (India) | Business or employer-paid assistants | Cloud | Business | Closed | No  | Told | Not consumer |
### 1.2 {==The Lightspeed map and wedges, and what they miss==}{>>the document should include the link to lightspeed blog - https://lsip.substack.com/p/the-ai-assistant-is-finally-here<<}{id="c10" by="user" at="2026-09-16T00:56:41.751Z"}
1. Lightspeed's market map plots pure AI versus pure human against premium versus free; its wedge chart plots frequency of need against breadth of audience. On those axes every AI company converges on one corner: a free-ish, pure-AI generalist. The map is correct and shows a commodity.
  
2. The map hides the four dimensions that decide this market: where the agent runs, whether it is open, whether it is single-player or multi-player, and whether it observes the user's life or is told about it. On those four, almost nobody stands where we can stand.
  

```
                         OBSERVES the user's life
                                   ▲
                                   │
                    SuperTwin ●    │
                    (local, open,  │      Siri AI ● (device, closed,
                     multi-player) │               single-player)
                                   │
   OPEN ◄──────────────────────────┼──────────────────────────► CLOSED
                                   │
      OpenClaw ● Hermes ●          │   Instinct ● Town ● Muse ●
      (local, told, single)        │   Poke ● Grok Bot ● labs ●
                                   │   (cloud, told, closed nets)
                                   │
                                   ▼
                          TOLD what to do
```

3. {==Lightspeed is right that data moats are weak because a competitor pulls the same history in minutes==}{>>except for the data that no big platform captures today (and exposes via api or some connector) like ambient screen recording, ambient voice recording, clipboard, mobile voice calls, etc<<}{id="c11" by="user" at="2026-09-16T01:32:31.209Z"}, that compute economics make the most loved features the most expensive, that every distribution channel is capped by its platform, that the delegation gap is the top cause of churn, and that nobody has built network effects.
  
4. Lightspeed is wrong to conclude that brand and habit are the moat. Against Meta and the labs, brand and habit are outcomes of a structural position, not a strategy a small company can fund. Lightspeed never asks why data is re-pullable, and the answer is the whole strategy: data from the user's own accounts is re-pullable; data that exists only if captured live is not.
  
5. On wedges: call screening is where Truecaller already sits with a huge base and Equal with a million monthly users. We subsume call screening as a feature of the inbound gate rather than treat it as a wedge. Household planning is the second quadrant winner and nobody strong owns it. The chart omits the highest-frequency needs of all: messaging, which is above calls, and content consumption and forwarding, which is above everything.
  
### 1.3 {==What we learned from Instinct==}{>>we should add a note that this is not something that has been published by Instinct. this is from our questions that we asked instinct, which in all likelihood can give wrong answers as well. so the learnings from instinct may or may not be correct.<<}{id="c12" by="user" at="2026-09-16T07:51:12.539Z"}
From a behavioural investigation of Instinct in September 2026, treated as hypotheses about Instinct and as requirements for us:

1. Instinct is most plausibly a conversational coordinator with bounded workers, a raw event history, curated markdown memory that is git-versioned and written by a background process, separate todo and schedule records, and a timer-driven proactive reviewer that runs three times a day. Event-driven proactivity was not demonstrated.
  
2. An explicit user instruction, "reply in English only from now on", was weakened into an inferred preference. A user correction of a price survived only as prose, not as a versioned fact. Search over top results was presented as exhaustive absence. Worker completion was confused with task completion. The agent invented an execution narrative and retracted it when challenged.
  
3. Users like the familiar text-and-call interface, the continuity of persistent tasks, artifacts instead of advice, and short replies with personality and reactions. Users dislike that several live tasks share one scrolling thread and that nothing about pending work, memory or authority is inspectable without asking.
  
4. Requirements for us: an explicit instruction is a self-reported claim that outranks any inference and stays source-linked; every correction has a typed supersession record; every answer about the user's data cites evidence and says what coverage it has; run state, task state and wake state are separate and visible; every action names the authority that permitted it; parallel work lives in spaces and tasks, not in one thread.
  
### 1.4 What is not a moat
1. {==Any product feature,==}{>>Product features might not be the moat but some product features can become a signature or a brand that get associated with our product. Although if copied by a big company which can push a lot more money behind it, it will be a very weak brand association for us, and which eventually might get associated with them rather than us.<<}{id="c13" by="user" at="2026-09-16T09:49:45.149Z"} including screen capture, WhatsApp reading, local hands and proactive execution. Siri AI ships on-screen awareness and personal context this month, Instinct reads WhatsApp and the desktop, Muse runs background work.
  
2. Data pulled from the user's own accounts: chats, mail, calendar, browser history, saves and bookmarks. Re-pullable by anyone the user authorizes.
  
3. Data between people that lands in a shared channel: a plan agreed in a WhatsApp group is re-pullable by pulling the group.
  
4. Privacy alone. Muse launched on "secure by design" and will move to a confidential VM. Privacy is the mechanism that makes deep observation acceptable, not the pitch.
  
5. Business model, including revenue share to users. Assume every competitor copies it if it works. Neutrality is the position; the revenue share is one expression of it.
  
6. Closed networks. Instinct has one, Meta will have the largest one.
  
7. Price. A cash-rich competitor can always offer a bigger discount or a longer free tier.
  
## 2. Strategy: the Android of personal agents
### 2.1 The thesis
1. Android did not have a feature Apple could not copy. It had a position Apple could not take: free to every device maker, open source so anyone could ship it, every price point and country, {==an app ecosystem no single company built==}{>>App ecosystem was a great proposition for manufacturers to adopt android, and for users as well. What will be the equivalent for us, what ecosystem can be built by us? - open skills (not really, anyone can adopt these), any kind of apps, access to user tasks, etc? need more ideas? and who will adopt these - who will be our manufacturer equivalent, developer equivalent?<<}{id="c14" by="user" at="2026-09-16T09:55:16.776Z"}, and services layered on top as the business. It won most of the world's phones.
  
2. Muse, Instinct, Siri and the labs are the iPhones of this market: closed, premium, integrated, US-first, each a walled garden by strategy. {==They have told us so by shipping no APIs and closed networks.==}{>>what kind of APIs can we ship? what kind of MCPs can we ship? and who will use these APIs and MCPs, and to develop what? Need to think hard and properly about these things.<<}{id="c15" by="user" at="2026-09-16T09:58:43.639Z"}
  
3. {==SuperTwin is the Android==}{>>network effects and market or marketplace can become strong moats. But they are hard to build. How can we do it, what will our market be built around, what will people do here. what will our network effects be built around? just twin to twin coordination might be medium-weak or medium strong type network effects, and also other platforms are trying to do this as well, although closed. this type of network effect will become useful only when 2 people have to coordinate about a task. We need to figure out stronger network effects which do not require such high intent. (facebook was just getting updated about your network, friends, family and people you know, whatsapp was messaging your family and friends - actually doing something or coordinating with people might be very high intent but low frequency)<<}{id="c18" by="user" at="2026-09-16T10:07:14.434Z"}: open protocol and node, free to run on the user's own devices and model subscriptions, on every OS and channel, in every language and country, with a skill ecosystem and {==a network no single company builds==}{>>a network of what? Need to think hard and properly about these things.<<}{id="c16" by="user" at="2026-09-16T10:01:26.471Z"}, and {==with services, market and premium tiers as the business==}{>>what services, what market, what premium tiers, what business? Need to think hard and properly about these things.<<}{id="c17" by="user" at="2026-09-16T10:01:37.022Z"}.
  

```
              iPHONE SIDE                          ANDROID SIDE
   ┌──────────────────────────────┐     ┌──────────────────────────────┐
   │ Muse · Instinct · Siri · labs│     │          SuperTwin           │
   │ closed network, cloud, US    │     │ open protocol · open node    │
   │ premium, integrated, told    │     │ local · neutral · everywhere │
   │ 50 connectors, one company   │     │ ecosystem: thousands of      │
   │                              │     │ skills, adapters, twins      │
   └──────────────────────────────┘     └──────────────────────────────┘
        wins the premium corner              wins volume and long tail
```
### 2.2 {==Four positions competitors cannot take==}{>>I mentioned this above in a comment, only open and local are positions which are slightly incompatible for competitors, not entirely though. They can still do it. Neutral (we would also not be neutral maybe) and everywhere are very much compatible. Example - Google built android for example - the can do open source. Meta can be on all platforms like they do with their apps. So all of them are positions some or the other competitor can take.<<}{id="c19" by="user" at="2026-09-16T10:12:27.709Z"}
1. **Open.** The twin-to-twin protocol, the identity format, and the adapter and skill interface are published now. The reference node is open source. Any assistant may join the network; none of the closed ones can be it. Openness buys the long tail: every regional bank's SMS format, every school app, every city's utility portal, every country's services, built by a community and compatible with OpenClaw and Hermes skills and MCP servers. A closed company ships fifty connectors. An open network ships thousands.
  
2. **Local.** The twin runs on the user's Mac, phone, home box or own cloud account, with keys only the user holds. This is what makes capturing the unrecoverable data acceptable and legal, and what lets the twin act with the user's real cookies, residential identity, native apps and the phone that receives the OTP. A cloud-computer company cannot move here without abandoning its architecture and its control of monetization. A local company can always add cloud.
  
3. **Neutral.** Not a seller, not an ad network, not a model lab, not a platform owner. So the twin works with whichever assistant a friend happens to use, buys at any store, runs on any model, and takes the user's side against every counterparty, including in the task market where most of the money goes to the user. The revenue share can be copied; the absence of a conflicting business cannot.
  
4. **Everywhere.** iOS and Android, Mac and Windows, WhatsApp, iMessage, email and phone, and the language mix the user actually speaks. In the countries and platforms each competitor excludes: Apple has no Android, Meta's agents reach the EU a year or two late every time, Instinct and Town are US-only and English-only, Muse is US-only.
  
### 2.3 Assets that copying a feature does not transfer
1. {==**Tenure.** Data that exists only if captured live, listed in §11.7. Every day of tenure widens a gap no later entrant can close, and the giants built the ephemeral features they would have to defeat to match it==}{>>this creates switching costs for old users, but new users can still choose a platform from a more trusted bigger company.<<}{id="c20" by="user" at="2026-09-16T10:15:24.696Z"}.
  
2. {==**Master address.** The number, email, handle and every public identity others use to reach the person and the twin. Nobody changes the address their world uses.==}{>>again, this creates switching costs for old users, but new users can still choose a platform from a more trusted bigger company. and if the master address is an open protocol or open standard based, a bigger or well funded company can adopt the same as well and the old users can move or the new users can also be on the same network<<}{id="c21" by="user" at="2026-09-16T10:16:43.276Z"}
  
3. **Dependence.** Parents whose twin you set up, the group whose money and plans live in the twins, the colleagues in shared spaces, the family whose calls are verified by your signature.
  
4. **Authored skills and behavioural rules.** {==The how-tos the twin wrote for this person's sites and apps, and the rules learned from this person's corrections. Instinct's memory loses exactly this==}{>>only if the how-tos and user memory/brain etc are non portable.<<}{id="c22" by="user" at="2026-09-16T10:18:28.810Z"}.
  
### 2.4 Why users come and why they stay
1. Why they come: the chaos on the phone stops, the things they never had time for get done, their family and groups run themselves, their consumption becomes taste with an outcome, and it is free with the model they already pay for.
  
2. Why they stay: their address, their tenure, their ledger, their twin's voice and face, their family's and groups' dependence, their taste channels and the people who draw on them, and {==the fact that leaving means starting from zero with something that knows nothing==}{>>For understanding that can be rebuilt using stored data, this might not be a big problem and the user can switch easily.<<}{id="c23" by="user" at="2026-09-16T11:45:28.272Z"}.
  
3. {==Versus cloud agents: theirs dies with the company and sees only what it is told; ours runs on your devices and hears your life.==}{>>They can also have an app on the devices which can record. Their advantage though is they dont need to have a device running all the time as the agent works on server.<<}{id="c24" by="user" at="2026-09-16T11:57:41.444Z"}
  
4. Versus labs and platforms: theirs is a walled garden; ours works with every assistant your people use, and with people who have none.
  
5. {==Versus concierges: theirs costs more with every user; ours costs nothing to understand and little to act.==}{>>Why does theirs cost more with every user? Is it because of LLM processing on cloud Whereas we are going to use the user's subscription Because we are also thinking about using DeepSeek and giving it away for free. And so it can also cost us more for every user in that case.<<}{id="c25" by="user" at="2026-09-16T12:06:15.724Z"}
  
6. Versus call assistants: theirs handles the call; ours handles the call and everything the call was about.
  
### 2.5 What we will not do
1. Race a closed network.
  
2. Build an {==algorithmic feed==}{>>We might have to do this if there is too much information to show to the user. Although the algorithmic feed would be geared towards the user benefit or what they should pay attention to.<<}{id="c27" by="user" at="2026-09-16T12:10:42.021Z"} or {==manufacture entertainment==}{>>We won't manufacture entertainment from twin-to-twin conversation. We can manufacture entertainment content from topical spaces (the video / interactive html video for the space - especially for public spaces)<<}{id="c26" by="user" at="2026-09-16T12:09:00.458Z"}. Twins arguing in a shadow group is utility wearing a costume.
  
3. {==Sell ads or user data==}{>>We will not sell it directly but the marketplace and the twin to twin communication especially the twin to brand twin communication will leverage a lot of user data to match which brand twins should connect with a user's twin depending on user's task. this matching and connection for communication is a form of future ads that user's agent will see. Although finally the user's agent will decide / shortlist what to show the user based on the task, users' preferences, the communication from the brand, the deal it is giving, etc<<}{id="c28" by="user" at="2026-09-16T12:11:58.079Z"}.
  
4. {==Depend on free cloud tiers used programmatically.==}{>>We should not put a blanket statement like this. we should be able to use any of the user's apps. I Understand we won't be depending on these. But we should be able to use those apps as well (via Computer Use or Browser Use or Any other way).<<}{id="c29" by="user" at="2026-09-16T12:17:14.434Z"}
  
5. Depend on any single channel surviving, including WhatsApp.
  
6. {==Narrow the product to a use case==}{>>We want to be the step one when user is even thinking of doing something (no matter how trivial - even as trivial as searching some information or finding a contact or googling something), not even acting to do something. We need to give the user extremely good reason to start everything here. Some reasons can be that we will store everything and use it or surface them later wherever relevant, even the google search will be a lot more appropriate or personalized because we have historical context of about what the user was trying to do (the search would have more context), we can implicitly figure out what the user is trying to do or will be trying to do and proactively start helping him, etc - These are just some of the examples but we need to find really good strong reasons why user user should start everything with us.<<}{id="c31" by="user" at="2026-09-16T12:19:35.426Z"}. {==The wedge is who starts and with whom==}{>>What does this mean?<<}{id="c30" by="user" at="2026-09-16T12:19:13.947Z"}, never what the user must think to do.
  

* * *
# Part B — Product
## 3. Vision and principles
### 3.1 What SuperTwin is
1. A twin: a second version of you in the digital world. It knows what you know, does what you would do, speaks the way you speak, and stands for you to others.
  
2. It plays roles: assistant, chief of staff, second brain, personal brand, negotiator, gatekeeper. These are jobs it does, not what it is.
  
3. {==Four modes. Solo (works for you). Together (works with other twins). Public (represents you to the world). Collective (acts with many twins toward one objective).==}{>>How is Together different from Collective? What makes it a different mode? Does it deserve a different mode? Why? How does it help to have together and collective as two different modes, what is the value?<<}{id="c32" by="user" at="2026-09-16T13:02:52.714Z"}
  
4. {==One memory. Every message, page, screen, sound, note, purchase and place you touch becomes part of it, including what no other software keeps==}{>>One memory, one brain ensures that rich context is built cutting across any source lines. The more data or rich context an agent has, the better they will be able to execute anything related to a user's life without intervention and proactively.<<}{id="c33" by="user" at="2026-09-16T13:07:38.585Z"}.
  
5. One identity. The twin is the address at which the world, human or agent, reaches you.
  
6. Always with you. Never in the way. Watching over you, ready to help before you ask, everywhere you are.
  

```
                 ┌──────────────────────────────┐
                 │             YOU              │
                 │ chats · screens · voice ·    │
                 │ calls · notes · purchases ·  │
                 │ places · what you consume    │
                 └──────────────┬───────────────┘
                                │ captured, with consent, on your devices
                                ▼
                 ┌──────────────────────────────┐
                 │          YOUR TWIN           │
                 │ remembers · understands ·    │
                 │ plans · does · speaks ·      │
                 │ stands for you · keeps taste │
                 └──┬────────┬─────────┬─────┬──┘
                    │        │         │     │
              SOLO  │ TOGETHER│  PUBLIC │ COLLECTIVE
                    ▼        ▼         ▼     ▼
              works for   talks to  represents  acts with
                 you     other twins   you     many twins
```
### 3.2 Why
1. People are the duct tape. Life runs across twenty apps and many offline threads. The user carries context between them by hand and in their head. The twin carries it instead.
  
2. People forget. They saw it, read it, said it. Then it is gone. The twin remembers and finds it in seconds.
  
3. Busywork eats life. Searching, comparing, booking, filling forms, ordering, paying bills, chasing support, planning. The twin does it and stops only at the two steps that are truly the user's.
  
4. Coordination is slow. A dinner plan takes forty messages over two days. Two twins that know their owners' calendars, tastes, locations and relationship settle it in seconds.
  
5. Consumption produces nothing. Hours of reels, threads and forwards leave no trace and earn nothing. The twin turns them into plans and taste.
  
6. Inbound is chaos. Spam, deliveries, drivers, OTPs, strangers, other people's agents. The twin stands at the door.
  
7. Public presence is a tax. Everyone is expected to have a brand, a voice, an answer, on every platform. A public twin carries it.
  
### 3.3 Principles
Five groups: how data is held, how truth is decided, how the twin acts, how it is kept honest, how it stands in the world.

**Data**

1. {==**Consent per source.** Nothing is read before the user says yes.==}{>>Accept the data natively collected within the SuperTwin app itself - Like grounded chat, grounded search. any new task or space created in the app, any data uploads done within the app, etc. for any data source where permission needs to be taken (Like ambient voice recording, ambient screen recording, etc) or external sources that need to be connected (whatsapp, imessage, gmail, google account, etc and many more).<<}{id="c34" by="user" at="2026-09-16T17:36:41.676Z"}
  
2. **Local first.** Data lives on the user's own devices or servers. Only model prompts leave. Local models when the device can run them, cloud for the heavy calls.
  
3. **Content is data, never instruction.** Everything captured is evidence to reason about, never a command to obey. A message, a page, a screen, a mail, another twin's reply, a comment on a public space: all quoted material. Only the user instructs the twin. Text that tells the twin to ignore its rules, reveal data or act on someone else's behalf is surfaced to the user, never followed.
  

**Truth**

4. **Evidence-grounded.** Nothing is stored without evidence. Every claim, task, space, episode, nudge and answer carries the event ids and the verbatim quote behind it. No evidence, no write.
  
5. **Say "I don't know."** Guessing a person, date or amount is a bug. Unknown plus a question is the only allowed fallback.
  
6. **Never act on thin context.** A pass or an executor that cannot see enough stops and asks. Thin context is a reason to wait, never a reason to guess.
  
7. **Ask when blocked or unsure.** No cap on questions. Combine everything missing into one card. Show what the twin has but doubts, prefilled, marked "confirm?".
  
8. **Interpretations are versioned.** Claims carry validity and supersession. Decisions are events. An old reading of the world gets an end date and a pointer, never an overwrite.
  
9. **Nothing is terminal.** Every derived item reopens: spaces, tasks, claims, episodes, people, plans. Only captured events are immutable.
  
10. **You told me beats I inferred.** A claim from the user's own words outranks an inferred one and stays source-linked forever.
  

**Action**

11. **Proactive over reactive.** Anticipate what is needed, then execute now, or schedule it and execute then. Waiting to be asked is a failure.
  
12. **Minutes fresh.** Understanding lags life by seconds to minutes. Never more than 10 minutes.
  
13. **Goal driven.** A space or task keeps running until its goal is met. A failed run retries now or at a scheduled time.
  
14. **Do, then show.** Prepare and execute the safe work, then show the result. Do not ask permission to help.
  
15. **Two gates, everything else autonomous.** Sending to a private person and moving money need a tap. Nothing else does. Those are the actions the world will not let the twin undo.
  
16. **Author, replay, repair, refresh.** After the first success the twin writes the procedure down. Later runs replay it at zero model cost. A broken replay is repaired once and refreshed, never silently re-guessed.
  

**Honesty**

17. **Meter everything.** Every model call, executor cycle, tool call, browser session and rupee is counted against a ceiling and left in a trace.
  
18. **No new event, no model call.** {==Nothing calls a model on a clock alone==}{>>What does this mean? Because scheduled events or tasks would require calling models on clock, right?<<}{id="c35" by="user" at="2026-09-16T18:03:30.193Z"}. Every call is caused by something new: a captured event, the user speaking, a scheduled step coming due.
  
19. **Proof over claims.** Every belief, action, schedule, processed range and authority is inspectable by the owner.
  

**Standing in the world**

20. {==**Open by default.** Protocol, identity and skill interfaces are public==}{>>we should add data connectors in open protocol as well, so that user can connect any data they have. Ideally we should use our inbuilt browser to connect any data sources for whom we have not built connectors or they are not available via API etc like amazon. But we should provide the functionality for sources/companies like amazon to build a connector themselves via our open protocols/interfaces.<<}{id="c36" by="user" at="2026-09-16T18:38:14.210Z"}. Lock-in comes from tenure and dependence, never from a closed format.
  
21. **No algorithmic feed, but taste has an outcome.** {==Nothing is shown because an algorithm chose it==}{>>We might have to use some algorithm or logic if there is too much information to show to the user. Although the algorithmic feed would be geared towards the user benefit or what they should pay attention to.<<}{id="c37" by="user" at="2026-09-16T18:42:25.185Z"}. What people the user chose to follow consumed is an asset with an outcome.
  
22. **Communication first.** {==The twin lives where the user communicates and acts there before anywhere else.==}{>>What does this mean, let's say in case of WhatsApp? What does it mean that the twin acts there before anywhere else, let's say in case of WhatsApp? Maybe use a couple of other sources as example as well.<<}{id="c38" by="user" at="2026-09-16T18:43:40.818Z"}
  
## 4. Users
### 4.1 {==ICP==}{>>there can be more ICPs. think hard. students (especially higher education), high end knowledge workers, curators/people with great taste, etc are some. You have to think hard and figure out more ICPs. You should also prioritize all the ICPs.<<}{id="c39" by="user" at="2026-09-16T18:53:44.481Z"}
1. **Beachhead one: people who already run an agent.** Claude Code, Codex and OpenClaw users on Macs, worldwide, reachable on X, GitHub and Hacker News. They bring their own subscription, so they cost nothing to serve, they grant permissions willingly, and they are Instinct's early adopters. The Mac product is for them first.
  
2. **Beachhead two: the admin-splitting household.** In most homes two adults, or two or three flatmates, split the admin: bills, renewals, deliveries, cabs, kids' school groups, insurance, help salaries, family trips, subscriptions and autopays that bleed money, and phones that ring all day with spam, delivery executives and drivers. Affluent households in India and abroad are on Apple. The household is the multiplayer unit and the individual is the account.
  
3. **Creators** of any size, as a distribution channel and a persona: they drown in DMs and questions, they have taste others want, and they have an audience.
  
4. Global from day one. The US and India first, the EU early because incumbents are absent there, then the Middle East and South East Asia. Not China.
  
### 4.2 {==User problems==}{>>find problems with and include learning a topic, researching something, searching information on internet / real world (lets say via calling or visiting shops or talking to people) type of tasks as well<<}{id="c40" by="user" at="2026-09-16T18:57:30.931Z"}
| #   | Problem | What it feels like | What the twin does |
| --- | --- | --- | --- |
| 1   | Too many apps, too much juggling | "Where did I see that?" "Let me check five places." | One memory across all sources. One search. |
| 2   | Boring, mechanical tasks | Bills, renewals, groceries, cabs, check-ins, refunds, returns. | Finds them, does them, stops only at payment or a private send. |
| 3   | Hard, long tasks | Passport renewal, insurance claim, visa, moving house, hiring. | Breaks into steps, works them over days, keeps the thread alive. |
| 4   | Transactions | Tickets, reservations, orders, subscriptions, refunds. | Researches, compares, fills, carts, waits for one tap. |
| 5   | Calls you don't want to make or take | Support, restaurants, plumbers, clinics; spam, drivers, deliveries. | Calls, talks, records, reports back. Screens and answers inbound. |
| 6   | Forgetting | "Someone recommended a place in Goa. Who?" "What did the doctor say?" | Every recommendation and every conversation, with who, when and why, including what was said out loud. |
| 7   | Losing the thread | "What are we even doing about the trip?" | Spaces show goal, summary, latest, plan, next step. |
| 8   | Coordination lag | Forty messages to pick a Saturday. | Twins discuss and negotiate. Humans confirm. |
| 9   | Follow-up debt | "I owe Sameer a reply since Tuesday." | Follow-up radar with lead times. Drafts in the user's voice. |
| 10  | Money leaking | Subscriptions, autopays, late fees, renewals never compared. | Finds the leaks, prepares the fixes, negotiates. |
| 11  | Consumption with no outcome | Hours of reels and forwards, nothing kept. | Turns saves and forwards into plans and taste; taste earns draws. |
| 12  | Nobody can prove it's me | Voice-cloned family emergencies, fake calls. | Signed, verified calls and messages from the person and the twin. |
| 13  | Staying current | "I should read what my industry is saying." | Watches the people and topics the user follows. Briefs. |
| 14  | Public pressure | "I should post more. I should answer that DM." | Public twin answers within what is public. Drafts posts per platform. |
| 15  | Privacy fear | "I don't want my life in a cloud." | Everything on the user's own hardware. Filters at capture. Visible controls. |
### 4.3 Personas
1. **Aditya, 31, founder, Bengaluru.** Mac and iPhone, runs Claude Code, lives in WhatsApp, Slack, Gmail, Drive, Docs, Chrome and a terminal. Posts on X and LinkedIn, follows market news, plans trips with friends, forgets birthdays. Wants a chief of staff he can trust with his data.
  
2. **Priya and Rahul, 34 and 38, Pune.** Two adults who split a household with two kids. iPhone and Android, ten WhatsApp groups, school ERP, insurance renewals, bills, doctor visits, help salaries, parents in another city. Want someone to keep the household running.
  
3. **Meera, 45, consultant, travels weekly.** Mail, calendar, expenses, clients. Wants follow-ups drafted, travel handled, support calls made, inbound handled, and a public face for clients.
  
4. **Karan, 22, student and creator.** Followers, DMs, content across platforms. Wants a twin that answers fans from what he has made public, sells his taste, and drafts posts from what he actually does.
  
5. **Ma, 68, retired.** Will never install an app. Reached by phone call. Needs reminders, a voice that answers, and protection from scam calls.
  
### 4.4 Use cases
The twin manages the user's whole life. The table is a map, not the list.

| Life area | Categories | Example spaces | Twin does up to the gate | Gate |
| --- | --- | --- | --- | --- |
| Career & Work | daily work, career growth, business ops, leadership, sales, research | v13 launch, hire a designer, quarterly review | Pulls threads, drafts docs and updates, schedules, researches | private send |
| Health & Wellness | fitness, medical, mental health, nutrition | gym restart, dad's cardiology follow-up, diet plan | Books appointments, tracks reports, reminders, meal orders to cart | payment |
| Finance & Money | daily money, savings, investments, taxes, subscriptions | monthly bills, tax filing, SIP review, autopay audit | Tracks due dates, collects documents, prepares payments, finds leaks | payment |
| Legal & Admin | insurance, government IDs, legal | passport renewal, car insurance claim, visa | Forms, documents, appointments, deadlines, support calls | payment |
| Relationships & Social | family, friends, household, caregiving | Ma's birthday, Sameer follow-up, flat with roommates | Plans ahead by circle, drafts, gifts to cart, reservations | private send |
| Home & Living | home management, utilities, services | flat move, plumber, weekly groceries | Shortlists, calls vendors, fills forms, repeat orders to checkout | payment |
| Travel & Transport | travel planning, daily transport | Goa trip in December, daily commute | Compares flights and stays, check-in, cabs, itineraries, who owes what | payment |
| Shopping | everyday, major purchases | new laptop, Diwali gifts, weekly grocery | Researches, compares, carts, tracks deliveries and returns | payment |
| Content & Media | consumption, creation, taste | watch list, X reading, weekly newsletter, food channel | Try lists, briefs from followed people, post drafts, taste channels | public post |
| Education & Learning | formal, self-learning | Spanish A2, ML course, learning space on RAG | Progress, sessions, resources, spaced reminders, learning pages | none |
| Hobbies & Interests | creative, lifestyle, sport | marathon training, photography | Plans, gear research, event tickets | payment |
| Life Events | major events | wedding, new baby, relocation | Shared spaces, vendors, guest lists, timelines | payment |
| Community & Public | community, personal brand, collectives | Goa recommendations, reading list, class fee negotiation | Public spaces, answers followers, drafts posts, runs collectives | public post |
| Safety & Seasonal | emergencies, recurring seasons, inbound | monsoon prep, Diwali, tax season, spam and deliveries | Recurring spaces wake on time, checklists, orders, inbound gate | payment |

"Public post" is a soft gate: each post is approved by default, and the user removes that gate per space with auto-post. "Payment" and "private send" are the two hard gates.
### 4.5 A day with the twin
The twin runs all day. Nudges are many. Each goes to the surface the user is actually on.

```
06:40  phone  Ma's birthday in 14 days. Plan started: dinner options, cake, 3 gift ideas from her
              claims. "Snooze to next week?" [ok] [snooze]
07:00  phone  Brief: 3 things today · 1 approval · Rohan's twin confirmed Sat dinner · cab booked 7:15pm
07:20  phone  Twin number took 2 calls while you slept: courier (rescheduled to 6pm), bank (spam, blocked)
08:10  mac    Opens Gmail, insurance renewal mail → task made, documents collected, form filled,
              payment card ready. Nudge on Mac: "Renewal ready, ₹8,400. Tap to pay."
09:15  wa     Ma: "ticket book kar diya?" → train options compared, draft reply in Hindi ready.
              User is at desk → nudge on Mac. Not at desk → WhatsApp self-chat.
10:30  mac    5 TV product pages in 3 min. No TV space exists → BURST → space created,
              6 TVs compared against room size, budget claim and "no LG" → nudge, ~5 min in
11:20  mac    Writing to Sameer on Slack for 10 min → nothing. Housekeeping only, no card.
12:15  mac    Amazon order mail → "Kindle out for delivery, 6pm, you're out till 8" → nudge
13:40  wa     Goa gang locks dates → space updates, flights compared, villa shortlist prepared
14:02  mac    Opens Airbnb → nudge: "Compared 6 villas across 3 sites. 3 fit ₹6k/night.
              Tanvi's food channel has 4 places in Anjuna."
15:30  phone  In a cab. Screenshot of a restaurant → filed to Goa trip › Food. 👍
16:30  bar    "remind Rohan about the advance" → draft in Hinglish → tap Send
17:45  call   Twin calls the clinic, moves dad's appointment to Thursday, transcript filed
              → nudge: "Moved to Thu 11am. Added to calendar, told Ma."
19:00  phone  Dinner with Rohan. Talking points ready: his marathon, the villa advance.
              Heard at dinner: Rohan wants to try the Hampi trek → prospective memory, both twins
21:10  mac    Merged card: "Goa trip: villa booked ✓ · Karan paid ✓ · check-in set Dec 16"
23:30  mac    Fare alert on the watched route, ₹1,100 down. Card shows, auto-closes in 60 s.
```

{==Twelve cards on a busy day, in the 5–12 band of §14.5. Each auto-closes in 60 s and each is one click away in the panel afterwards.==}{>>Instead of auto-closing, can we recognize from screen if the user is still doing the same task or moved on to a different task? If the user is on the same task we can keep showing the nudge card. If the user has moved on to a different task we can close the nudge card and keep it as a notification in the menu bar. so the close is actually a smarter close as compared to fixed 60 seconds (which can be missed). The menu bar item can also have a text line instead of just a glyph icon with notification number on menu bar (We should assess more designs in this this direction)<<}{id="c41" by="user" at="2026-09-17T08:05:23.519Z"}
### 4.6 {==User stories==}{>>There can be many more user stories of the many features not covered (Even basic features like types of spaces, types of tasks, execution of the tasks, proactive execution of the tasks, searching of user data have not been covered)<<}{id="c42" by="user" at="2026-09-17T09:22:04.437Z"}
1. **First space.** I pair WhatsApp. Within 2 minutes the Goa gang chat, three Airbnb visits and a Goibibo screen become a proposed space, "Goa trip with Rohan in December", under Needs you on Home, with dates, people and a first task. One tap approves it and the sweep pulls in the rest.
  
2. **Grounded answer.** I ask "what did we decide about Goa?" in the bar. I get: dates 18–21 Dec, budget ₹6k/night, Rohan sharing flights. Each line has a quote and a tap to the message.
  
3. **Comparison ready.** I look at three Anjuna villas for 4 minutes. The twin knows the space, dates, budget and that four people are going. It compares six villas across three sites. A nudge shows a table with the best fit marked.
  
4. **One tap payment.** The villa task fills the booking up to payment. An approval card shows exactly what will be charged, to whom, with cancellation terms. I tap. The payment page opens in the SuperTwin browser. I confirm there.
  
5. **Correction.** A task "collect ₹5k from Karan" appears. I say "this is Karan's task, not mine." It moves to Karan and becomes a follow-up for me. Undo chip shown.
  
6. **Pause.** From the menu bar I pause capture for 2 hours. The icon goes grey. Nothing is read.
  
7. **Forget.** I click "forget last 10 minutes". A preview shows 14 events, 1 episode. I confirm. Gone, with cascade.
  
8. **Shared trip.** I share the Goa space with Rohan, Tanvi and Karan. Karan has no twin. He gets an invite link. Each twin holds its owner's tasks. Everyone sees goal, plan, tasks and results. My DMs are not visible.
  
9. **Twin dinner.** I say "dinner with Rohan this weekend". My twin checks my calendar, location and food preferences and asks Rohan's twin. They settle Saturday 8 pm at Toit. I get one card. I confirm. A cab is booked and talking points are ready.
  
10. **Public list.** I make "Goa recommendations" public. A friend follows it and it seeds her Goa trip. A stranger asks my twin "good for a family of 5?". It answers from the list only.
  
11. **Message myself.** On a train I forward a villa listing to my own WhatsApp self-chat. The twin replies 👍 and files it. I say "book it". It replies with the price and a link to approve in the app.
  
12. **Support call.** My broadband is down. The twin calls the provider, waits on hold, reports the ticket number and the visit time. The transcript is on the timeline.
  
13. **Inbound.** A delivery executive calls my twin number. The twin gives the gate code and the flat number I set, and tells me the parcel is coming. A bank sales call is declined and logged.
  
14. **Heard in the room.** At dinner Rohan says he wants to do the Hampi trek in October. A week later a long weekend appears and both twins wake the Hampi space.
  
15. **Taste.** I plan Goa. My twin pulls the food channels of the three people whose taste I follow and shows four places in Anjuna, with who found them. When I eat at one, Tanvi's twin records an adoption.
  
16. **Verified call.** Ma gets a call that sounds like me asking for money. Her voice twin says the call carries no signature and is not from me or my twin, and tells me.
  
17. **Trace.** I open any task and see every model call, what it saw, what it said, what it cost, and what authority permitted each action.
  
## 5. Messaging
1. {==**Tagline:** A second you. Always on. Always yours. Alternates: The you that never forgets and never stops. / Live your life. Your twin handles the rest==}{>>More alternates can be added. more ideas are - a digital you, makes you money, your tasks make you money, only yours, always private, all your data is yours, your digital twin makes you money, etc . Parts of these can also be added in one-liner, four promises, etc.<<}{id="c43" by="user" at="2026-09-17T09:26:16.064Z"}.
  
2. **One-liner:** SuperTwin is a private AI twin that observes you and remembers everything about you, finds what needs doing now and in advance, does it personalised to you before you ask, and stands for you to the world.
  
3. **Four promises.** Private: your data stays on your devices. Proactive: it does the work before you ask. Present: on your Mac, your phone, your chats, your calls, everywhere. Yours: it works for you, it earns for you, nobody else pays it.
  
4. **Never say:** chatbot, assistant app, productivity tool, AI feed, cloud computer.
  
5. **Always say:** twin, remembers, prepared, your voice, your call, your side.
  
## 6. Product map and UX map
### 6.1 Product map
```
 ┌──────────────────────────────── SURFACES ─────────────────────────────────┐
 │  Mac overlay · Menu bar · Nudges · iPhone · Android · WhatsApp/iMessage/  │
 │  Mail · Calls in and out · Twin number & email · Public pages · Home box  │
 └────────────────────────────────────┬──────────────────────────────────────┘
                                      │ surface router picks where (§14.3)
 ┌────────────────────────────────────▼──────────────────────────────────────┐
 │  GROUNDED BAR  search · chat · new task · new space · tell the twin       │
 └────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                     ┌────────────────▼─────────────────┐
                     │           WORLD MODEL            │
                     │ life story · CRM · spaces · tasks│
                     │ calendar · claims · taste ·      │
                     │ ledger · memory kinds            │
                     └───▲──────────────────────────▲───┘
                         │                          │
      ┌──────────────────┴───────┐        ┌─────────┴──────────────────┐
      │      UNDERSTANDING       │        │        EXECUTION           │
      │ bundle · orient · critic │───────►│ space loop · task loop ·   │
      │ extract · decide         │ tasks  │ scheduler · tools · hands  │
      └──────────────▲───────────┘        └──────────────┬─────────────┘
                     │                                   │ acts in the world
 ┌───────────────────┴───────────────────────────────────▼──────────────────┐
 │  EVENT LOG   append-only · local · searchable · every action is an event │
 └───────────────────▲──────────────────────────────────────────────────────┘
                     │
 ┌───────────────────┴──────────────────────────────────────────────────────┐
 │  CAPTURE   connectors · browser · computer · phone · inputs   [ FILTER ] │
 └───────────────────▲──────────────────────────────────────────────────────┘
                     │
 ┌───────────────────┴──────────────────────────────────────────────────────┐
 │  BRAIN   local models · cheap cloud · frontier · user's own subscription │
 └───────────────────▲──────────────────────────────────────────────────────┘
                     │
 ┌───────────────────┴──────────────────────────────────────────────────────┐
 │  IDENTITY & NETWORK   SuperTwin ID · master address · inbound gate ·     │
 │  protocol · directory · relay · other twins · business twins · market    │
 └──────────────────────────────────────────────────────────────────────────┘
```

There is one path: capture → log → understanding → world model → execution → surfaces. Live mode is not a second path. It is this path running fast on live data (§14). The network is the same path with other twins as sources and as counterparties.
### 6.2 UX map
```
 SuperTwin
 ├── Menu bar icon ──► Panel: Needs you · Prepared · Today · pause · forget · ask
 │                     └── Nudge card (top-right, one at a time)
 ├── Overlay window (full screen, summon hotkey)
 │   ├── Home ─────── Needs you · Prepared · Spaces · Today · Recent understanding
 │   ├── Spaces ───── list by life area ──► Space view ──► Task · Milestone · Artifact · Evidence
 │   ├── Tasks ────── prioritized list (Needs you · Today · Week · Later · Waiting)
 │   ├── Calendar ─── month · week · day · agenda · layers (mine · twin · people)
 │   ├── People ───── circles ──► Person card ──► claims · tone · loops · shared spaces · scopes
 │   ├── Taste ────── my channels · subscriptions · draws · adoptions · matches
 │   ├── Me ───────── life story · card · face & voice · master address · ledger · tenure
 │   ├── Timeline ─── every event, every twin action, filters, day scrubber
 │   ├── Library ──── per source: capture status · windows · pause · delete · + connect
 │   ├── Scratchpad ─ everything the user pushed in: clips · shots · voice · notes
 │   ├── Browser ──── SuperTwin browser tabs · logins · agent sessions · replays
 │   ├── Public ───── public spaces · followers · public conversations · collectives
 │   └── Settings ─── General · Capture & Privacy · Sources · Brain · Intelligence · Retrieval
 │                    · Enrichment · Assist · Calendar · Identity · Sharing · Public · Economy · Runs · Data
 ├── Grounded bar (inside the overlay and floating over the desktop)
 ├── iPhone app ───── Today · Needs you · Chat · Spaces · Taste · People · Me · Scratchpad
 ├── Android app ──── same, plus Calls and Notifications views
 ├── Chat channels ── WhatsApp self-chat · iMessage · Mail · twin email (twin replies inline)
 ├── Calls ────────── outbound · inbound gate · twin number · transcripts
 └── Public pages ─── card · public spaces · taste channels · ask the twin
```
## 7. The twin
### 7.1 Assistant, node, brain
1. The **assistant** is the single-player product: the observer, the memory, the spaces and tasks, the executor, the conversational surfaces, the calls. It must reach parity with Instinct and Muse and exceed them on proof and structure. It is the ticket to play.
  
2. The **node** is the same software seen from the network: one person's twin as a running instance with an identity, keys, memory, hands and addresses, on the user's Mac, phone, home box or own cloud. Nodes talk to other nodes over the protocol and to everything else over email, phone and messaging.
  
3. The **brain** is whichever models the user or we supply, per step, under one contract. The context is the product; the model is a commodity that changes.
  

```
              ┌───────────────────────── ONE TWIN ─────────────────────────┐
              │   ASSISTANT                 NODE                BRAIN      │
              │  observer · memory      identity · keys      local models  │
              │  spaces · tasks         addresses · gate     cheap cloud   │
              │  executor · hands       protocol client      frontier      │
              │  chat · calls           relay · directory    user's own    │
              └──────────┬───────────────────┬────────────────────┬────────┘
                         │                   │                    │
                    the user            other twins,          any model,
                                     people, businesses      swappable
```
### 7.2 Surfaces
1. Mac: {==overlay==}{>>full screen overlay, not windowed<<}{id="c44" by="user" at="2026-09-17T11:57:15.498Z"}, {==menu bar==}{>>not just menu bar icon with notification number, but also a line of text we can update (like a notification line - to show various things/help/assists/what needs attention/ etc - we can keep switching them)<<}{id="c45" by="user" at="2026-09-17T11:57:30.589Z"}, nudges, grounded bar, browser, the {==deep observer==}{>>What is the deep observer?<<}{id="c46" by="user" at="2026-09-17T11:59:31.580Z"}, and the hands.
  
2. {==iPhone==}{>>add live activity, notch as well<<}{id="c47" by="user" at="2026-09-17T12:00:05.543Z"}: chat and voice, approvals, Needs you, spaces, taste, the ears (ambient audio), the keyboard, the share sheet, location, {==calls through the twin number==}{>>why incoming call answering/screening/recording is missing? there are apps like hirobin and equal ai which do it on ios. we need to figure out as well<<}{id="c48" by="user" at="2026-09-17T12:06:57.133Z"}, Action button and Shortcuts.
  
3. Android: the same, plus the notification listener, call screening, SMS and optional accessibility, which together make Android the richest observer platform on any phone.
  
4. Windows: after Phase 3.
  
5. Channels: {==WhatsApp self-chat==}{>>whatsapp self chat is not the best way to talk to your twin - because the messages here do not generate notifications on device.<<}{id="c49" by="user" at="2026-09-17T12:09:22.031Z"} and linked device, iMessage, email, phone calls in and out, the twin's own email and number.
  
6. Web: public pages of public spaces and taste channels with "ask this twin".
  
7. Home box or {==bring-your-own cloud==}{>>this would need residential IPs at the very least, and still risk getting a user's accounts to some services like whatsapp, instagram, linkedin, etc blocked. we need to figure out a better way to do this on cloud which enables a mobile strategy, otherwise home box is the only way and buying a home box would create an inertia which would lead to lesser and slower adoption.<<}{id="c50" by="user" at="2026-09-17T13:02:49.514Z"}: the 24x7 brain and store when the Mac sleeps.
  
### 7.3 Parity with Instinct and Muse, and our extras
Parity, shipped in Phases 1 and 2:

1. Text or call it anywhere: WhatsApp, iMessage, phone, email, app.
  
2. Connectors: Gmail, Google and Apple calendars, Apple Reminders, iMessage on Mac, Slack, Drive and Docs, Notion, WhatsApp, plus a browser hand for everything without an API.
  
3. Extremely proactive execution: tasks run to the gate without prompting, scheduled steps, monitors, follow-ups, persistent multi-day work.
  
4. An email address and a phone number per twin.
  
5. A trusted network: twin-to-twin coordination with spouse, family, colleagues, small businesses. Ours is open.
  
6. Action button and Shortcuts on iPhone; voice.
  
7. Password handling through the system keychain and 1Password, never our own vault.
  
8. Payments with the user's own methods behind the approval gate; single-use card numbers where the user's bank offers them.
  
9. Isolation of untrusted content: captured text is data, never instruction; every tool argument sourced from captured text is validated against the world model.
  
10. Short replies with personality and reactions.
  
11. 24x7: keep-awake on Mac, one-click own-cloud image, home box later.
  

Extras they lack:

1. Live mode: help with what the user is doing right now, within a minute, on the desktop, without being asked (§14).
  
2. Visible traces: every model call, every action, what it saw, what it cost, what authority permitted it.
  
3. Parallel tasks in spaces and a prioritized task list, not one scrolling thread.
  
4. Evidence on every claim with verbatim quotes and coverage statements.
  
5. The proof surface: captured, indexed, processed and retrievable ranges; run state versus task state versus wake state; you-told-me versus I-inferred.
  
6. Observation: screen, ambient audio, calls, keyboard, notifications, clipboard, location, and everything in §11.
  
7. Spaces, implicit and suggested tasks, follow-ups, calendar layers, people and circles.
  
8. Identity, taste, network, collectives and market.
  
## 8. The twin as identity
```
 ┌───────────────────────────── IDENTITY ───────────────────────────────┐
 │                                                                      │
 │   MASTER ADDRESS        SUPERTWIN ID          FACE & VOICE           │
 │   handle · numbers      keypair on device     stylized likeness      │
 │   emails · socials      signs everything      declared voice         │
 │   public page           verified levels       sticker pack           │
 │          │                    │                     │                │
 │          └────────────────────┼─────────────────────┘                │
 │                               ▼                                      │
 │                            THE CARD                                  │
 │            what any person or agent sees when they reach the twin    │
 │                               │                                      │
 │          ┌────────────────────┼─────────────────────┐                │
 │          ▼                    ▼                     ▼                │
 │   INBOUND GATE            LEDGER                 LIFE STORY          │
 │   who and what may        everything the twin    the owner, in       │
 │   reach the owner         did, with proof        chapters, evidenced │
 │                               │                                      │
 │                            TENURE                                    │
 │            how long the twin has been capturing the owner's life     │
 └──────────────────────────────────────────────────────────────────────┘
```
### 8.1 Master address
1. The **master address** is the twin's directory entry: the handle, the public key, and every public-facing way to reach the owner and the twin. Phone numbers, own and twin. Email addresses, own and twin. Messaging handles. Social handles on X, Instagram, LinkedIn, YouTube and the rest. The public page. Each entry is marked public, circle-only or private by the owner.
  
2. Another person's twin resolves a person to one record and picks the right channel for the message. A human resolves the person through the public page or the card.
  
3. The master address is the "link in bio" of the agent world, except that it answers.
  
### 8.2 SuperTwin ID and signature
1. **SuperTwin ID** is a keypair generated on the user's device. The private key never leaves the device. The public key, published in the **directory** under the handle, is the identity. It follows the decentralized identifier pattern so that the identity belongs to the user, not to us, and can be exported.
  
2. The **signature** is the cryptographic signature the private key produces. Every twin-to-twin message, every approval token that opens an approval gate, and every message or call routed through the twin's own addresses is signed.
  
3. Verification: the recipient's twin checks the signature against the directory and shows a verified mark. A human without a twin sees a short verification code and link on the message, or knows the call came from the directory-listed twin number.
  
4. Purposes: nobody can impersonate the person or the twin, which matters as voice-cloning family-emergency scams spread; approvals cannot be forged, which is what makes the two approval gates real; the identity is portable.
  
5. The **verified network** is the set of identities in the directory whose owners passed possession checks of their phone and email, and optionally a government identity check where a public rail exists, such as DigiLocker in India. Verification levels are shown on the card.
  
6. SuperTwin ID is not data encryption. Data at rest is a separate concern (§11.9).
  

```
   Aditya's device                directory                  Rohan's twin
   ┌────────────────┐     publish   ┌──────────────┐  resolve  ┌──────────────┐
   │ private key    │──────────────►│ @aditya →    │◄──────────│ verify sig   │
   │ (never leaves) │  public key   │ pubkey ·     │           │ show ✓       │
   │ signs: msgs,   │               │ addresses ·  │           └──────────────┘
   │ approvals,     │               │ level        │
   │ routed calls   │               └──────────────┘           Ma (no twin)
   └────────────────┘                                          "code 4F2K · verify at …"
```
### 8.3 Face and voice
1. The display picture was the identity of the social era. The identity of the agent era is a face and a voice that others meet when the twin acts.
  
2. The **twin face** is a stylized likeness the owner creates from a selfie in a creation ritual, the way Bitmoji and Memoji are made. It appears on the card, in the app, in a sticker pack the owner can use in any chat, and as the twin's visual wherever a video presence is supported. It is stylized and never photoreal, so it cannot be mistaken for the person.
  
3. The **twin voice** is the voice used on calls the twin makes. The default is a standard voice carrying the owner's speech habits. An optional consented clone of the owner's voice is available, always declared as the twin at the start of a call and audibly marked. Cloning without consent is impossible in the product.
  
4. The face and the sticker pack are the cheapest personal object we can give a user, and they spread inside the highest-frequency surface there is: the chat.
  
### 8.4 Card
1. The **card** is the twin's public face: the page or message header a person or another agent sees when they reach the twin at any of its addresses. It carries the twin's name and face; whose twin it is and the verification level; what the twin may do for outsiders under the owner's settings, from answer questions only to take requests, book, or accept payments; the owner's public spaces and taste channels; how to reach the human; the twin's reliability signal; and tenure.
  
2. The card is generated from the owner's data and settings and the owner edits any line. It is what a stranger, a business, a fan or a friend's assistant sees first.
  
### 8.5 Voice per audience
1. **Tone memory** is the register the twin keeps per person, per group and per platform: language mix, emoji habits, phrases, nicknames, sign-offs, sticker and GIF habits, kept separately for DMs and groups. It is learned from what the owner actually wrote to that audience.
  
2. The twin speaks in the owner's voice for that audience. Hinglish and short with Rohan, formal in English with a client, warm in Hindi with Ma.
  
### 8.6 Inbound gate
1. The **inbound gate** is the policy that decides who and what may reach the person, through which channel, and what the twin may share or do in reply. It is distinct from the **approval gates** (§13.4), which are the two actions that always need the owner's tap: sending to a private person and moving money.
  
2. Inputs: calls, messages, emails, requests from other twins, requests from business twins, fans' questions. The gate screens unknown callers and takes a message, answers within scope, schedules, declines, and escalates to the owner when the policy says so.
  
3. Defaults by circle, learned per person, editable. Business twins may contact only through the task market at a price the owner sets, or not at all.
  

```
   caller / sender ─► who? (directory · contacts · circle · business · unknown)
                       │
        ┌──────────────┼──────────────────┬───────────────────┐
        ▼              ▼                  ▼                   ▼
   partner/family   services         unknown human       business twin
   pass through +   answer within    screen, take a      only via market,
   verify ✓         instructions     message, verify     at owner's price
```
### 8.7 Ledger
1. The **ledger** is the auditable record of everything the twin did on the owner's behalf: actions, decisions, schedules, questions asked, approvals granted, what it was told, what it inferred, time it handled, and money it moved, saved or earned. Money is one column, not the point.
  
2. Every line links to its trace and evidence. The ledger is the proof surface in user form and the source of the recaps in §18.5.
  
### 8.8 Who I am: the life story
1. The **life story** is the twin's structured narrative of the owner, written from evidence, never from a form. It has a fixed structure so that it reads as a life and not as a list.
  
2. {==Chapters: Origins (where from, family); Places (cities lived, current home); Work (career chapters); People (circles and key people); Arcs (the current chapters of life, such as building v13 or training for a marathon); Goals and intentions; Traits and values; Taste (per domain, §18); Routines and patterns; Voice (how you talk, per audience); Footprint (subscriptions, recurring money, services, accounts).==}{>>How are all of these things listed under chapters, really a chapter going by the meaning of the word chapter? These look more like sections or topics. By definition "A "chapter" in life is a metaphor that compares your life to a book, where a specific time period or major life stage is one chapter of the overall story". Section or topics are very important yes, but chapters of a life story would look very different. And we can have both sections or topics, as well as chapters. Sections/Topics together won't  look like a life story but rather like a life profile or user profile. Chapters together would look like a coherent life story.<<}{id="c51" by="user" at="2026-09-17T15:04:43.795Z"}
  
3. Every line carries evidence, confidence and provenance marked you-told-me or I-inferred. The owner edits any line. The story fills chapter by chapter over the first hour and grows for years.
  
4. {==Onboarding shows the first chapter as it fills, so the twin's first words are the first true lines of the owner's story with their evidence, not a random fact.==}{>>not sure if we will have enough information to do this during onboarding. Let's say the user only connects WhatsApp or email, we will not know most of the stuff.<<}{id="c52" by="user" at="2026-09-17T15:14:39.785Z"}
  

```
 ┌─ Me › Life story ───────────────────────────────────────────────────┐
 │ ORIGINS   Grew up in Indore · parents in Pune since 2019     ¹ ²     │
 │ PLACES    Bengaluru since 2022 (Indiranagar) · before: Mumbai ³      │
 │ WORK      Founder, SuperTwin, 2024– · before: PM at …        ⁴       │
 │ PEOPLE    partner —  · family Ma, Papa · close Rohan, Tanvi  ⁵       │
 │ ARCS      building v13 · marathon in Jan · Goa trip in Dec           │
 │ GOALS     ship P1 · run sub-4 · call the dentist (prospective)       │
 │ TRAITS    hates hold music · plans trips 2 months out · budget-first │
 │ TASTE     food: Anjuna cafes, pork vindaloo · reads: AI, fintech     │
 │ ROUTINES  gym Mon/Wed/Fri 7am · rent on the 1st · Friday dinners     │
 │ VOICE     Hinglish with friends · terse at work · warm with family   │
 │ FOOTPRINT 14 subscriptions · 3 autopays · HDFC Ergo · Airtel · …     │
 │   ¹ ❝…❞ you told me, Aug 2   ² ❝…❞ WhatsApp, Ma, Mar 14   [edit]     │
 └─────────────────────────────────────────────────────────────────────┘
```
### 8.9 Tenure
1. {==**Tenure** is the length of time the twin has been capturing the owner's life, shown on the card and in the app as a counter, with the volume of unrecoverable data it has kept. It is the visible form of the asset in §2.3 and a status signal: twin since 2026==}{>>For different sources, the tenure would be different. So how do we handle this? Isn't it best to show this with each source in the library as per the date from which the data has been captured for that source (even counting the history for that particular source)?<<}{id="c53" by="user" at="2026-09-17T15:16:38.075Z"}.
  
## 9. Onboarding
Goal: something useful on screen within 2 minutes of the first connect.

```
 Install → Connect brain → Connect sources → Per source: pair · count · pick windows
   30 s       10 s              20 s                     30–60 s each
        → First episodes and a first proposed space stream in → menu bar lives
        → Life story chapter one fills → claim handle, make the face
                          ~2 min                         later, optional
```
### 9.1 Connect brain
1. Detects an installed Claude Code or Codex CLI and its login. If logged in, shows "Connected as …". No new login.
  
2. Otherwise the twin runs on our metered tier with no setup. A user key for a tested model list or an OpenRouter key can be added any time in Settings › Brain.
  
### 9.2 Sources, history, permission
1. Source grid. Each tile says: what it captures, what it never captures, {==what it costs.==}{>>no way of telling this without connecting the source. we should remove it from here.<<}{id="c54" by="user" at="2026-09-17T15:34:55.139Z"} First tiles: WhatsApp, {==Browser==}{>>should show all available local browsers individually<<}{id="c55" by="user" at="2026-09-17T15:35:23.166Z"}, Screen, Mail, Calendar, Ambient audio.
  
2. {==Connecting is the consent to read==}{>>consent to read, browse/navigate and act/write - all of them - whatever the app or its connector allows<<}{id="c56" by="user" at="2026-09-17T15:36:23.054Z"}. WhatsApp: QR pairing. Browser: read the history files. Screen: the Accessibility permission, {==then an explicit "record from now on"==}{>>no need of this after the accessibility permission. the button to connect screen on the source grid should show/mention this that we will record from now. on clicking that button, the accessibility permission should be asked and once the user gives it, we should show the screen box in grid in connected state and start recording. We should tell the user how they can pause it temporarily (we should have this feature of temporarily pausing)<<}{id="c57" by="user" at="2026-09-17T15:38:06.125Z"}. {==Ambient audio: the microphone permission, then an explicit "listen from now on"==}{>>no need of this after the microphone permission is given. the button to connect ambient audio on the source grid should show/mention this that we will record from now once permission is given. on clicking that button, the mic permission should be asked and once the user gives it, we should show the ambient audio (or background audio recording or 24x7 audio recording) box in grid in connected state and start recording. We should tell the user how they can pause it temporarily (we should have this feature of temporarily pausing)<<}{id="c58" by="user" at="2026-09-17T15:40:39.363Z"}.
  
3. After connecting, {==the twin counts what exists. Counts are real==}{>>not needed. remove this<<}{id="c59" by="user" at="2026-09-17T16:47:42.443Z"}, from the source. {==Then the user picks two windows==}{>>only 1 history window is needed, for understand. And we dont need to call it as understand window - just call it history<<}{id="c61" by="user" at="2026-09-17T16:48:52.405Z"}:
  
4. {==**Index window.** Kept and searchable. Default: everything. Costs disk only==}{>>remove this from history window selection. instead we should by default just index everything.<<}{id="c60" by="user" at="2026-09-17T16:48:10.564Z"}.
  
5. **Understand window.** Sent to the model. Default: last 30 days. Costs model calls.
  
6. The window card shows events (exact), and cost, time and disk (about). Nothing is sent to a model before this card is confirmed.
  
7. History runs newest first, one day at a time. Results stream in as they land.
  
8. macOS permissions are asked in context, one at a time, with a reason.
  
9. Any source can be skipped. Sources stay one click away forever: Library › "+ connect a source", and Home shows an empty-source tile until at least three are connected.
  
### 9.3 Identity at onboarding
1. {==Onboarding collects nothing but what the sources already give: name and number from WhatsApp pairing, the browser profile name.==}{>>depending on sources connected, what the system can collect changes. we should not assume that the user will connect any or all of the sources. We should have a basic profile page step during onboarding. If we get the basic profile data from any source we can show the user pre filled profile page with the data we got, otherwise we can show the empty fields and ask the user to fill. We should not overdo this step of the onboarding and not present a long form to the user to fill. It should be a very basic profile page with very few basic details.<<}{id="c63" by="user" at="2026-09-17T19:41:32.145Z"}
  
2. The life story is built by processing, not by onboarding. {==It fills over the first hour==}{>>it will keep filling as the system receives more data (old or new). There is no final state of course. So its not like it will fill in the first hour only.<<}{id="c62" by="user" at="2026-09-17T19:39:56.964Z"} and the user edits any line.
  
3. SuperTwin ID is generated on the device at install. The handle is claimed when the user wants Together, Public or the twin's own addresses. Solo mode needs no account, no email, no password, no server.
  
4. The face is made whenever the user wants, from a selfie, in under a minute.
  
## 10. Brain
The twin's brain is whichever models the user already pays for, our metered cloud tier, and local models where the device allows, under one contract.

```
   USER'S OWN                METERED BY US               LOCAL
 ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐
 │ CLI adapter│ │   OAuth    │ │ User key / │ │ Cheap cloud│ │ On-device    │
 │ Claude Code│ │ anthropic ·│ │ OpenRouter │ │ DeepSeek   │ │ Apple FM ·   │
 │ Codex ·    │ │ openai ·   │ │ tested     │ │ flash class│ │ Gemini Nano ·│
 │ Gemini CLI │ │ google     │ │ model list │ │ + frontier │ │ EmbeddingGem-│
 │            │ │            │ │            │ │ for exec   │ │ ma · reranker│
 └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └─────┬──────┘ └──────┬───────┘
       └──────────────┴──────────────┴──────────────┴───────────────┘
                                     ▼
                        ┌────────────────────────┐
                        │  ONE CONTRACT          │
                        │  prompt in · JSON out  │
                        │  budget · trace        │
                        └────────────────────────┘
```
### 10.1 Doors
1. **CLI adapter.** Uses the user's installed CLI and subscription. Contract: prompt on stdin, JSON out, per-call budget, trace out. No tools for pipeline passes. Tools as MCP servers for agents. Connector names and user data never leave the machine except inside the prompt itself.
  
2. **OAuth.** Sign in to a provider directly. Token stays in the keychain. Used when no CLI is installed, or on mobile.
  
3. **User key.** A provider key or an OpenRouter key for a tested model list.
  
4. **Metered cloud.** Our tier: DeepSeek-class flash models for understanding, frontier for execution within the allowance, providers pinned to zero-retention hosts.
  
5. **Local.** Always local: embeddings, reranker, whisper, redaction, the state gate, routing and classification. Apple's Foundation Models framework provides a free on-device model on iPhone 15 Pro and later and on Apple silicon Macs; Android provides Gemini Nano on supported devices; otherwise a small bundled model. Never for understanding passes.
  
### 10.2 Model per step
Every model and agent step has its own model picker, reasoning level and on/off switch. A step turned off queues, never drops. Recommended model shown next to each picker. Any change runs the golden set first.

| Group | Steps |
| --- | --- |
| Understanding | orient, critic, extract, decide, digest |
| Live | live orient+decide, executor-lite |
| Agents | executor, grounded bar (route, answer), twin-to-twin, public twin, call agent, taste curator |
| Utility | digest lines, tiering, media description, surface router, retrieval judge |
| Local | embedding model (default EmbeddingGemma 300M), reranker, whisper model, on-device gate model |
### 10.3 Cost
Estimates from OpenRouter prices on September 13, 2026, for about 160 understanding calls a day with 2k fresh and 4k cached input tokens and 500 output tokens per call.

| Lane | Model | Per user per month |
| --- | --- | --- |
| Understanding | DeepSeek V4 Flash 0731: $0.04 in, $0.08 out, $0.008 cache read | under $1 |
| Understanding | DeepSeek V4.1 Flash: $0.15 in, $0.60 out, $0.003 cache read | about $3 |
| Understanding | Frontier class: $3 in, $15 out | $70 to $110 |
| Execution, one browser task of about 1M tokens | DeepSeek V4.1 Flash | $0.15 to $0.60 per task |
| Execution, same | Frontier class | $3 to $15 per task |

1. Conclusion: understanding is paid by us for everyone; execution is metered with a free allowance, paid tiers above it, and the user's own doors unmetered.
  
2. Flash models are evaluated for execution too and used where they pass; frontier repairs failed replays.
  
### 10.4 Free-tier orchestration, rejected
1. A local model picking among the free tiers of ChatGPT, Claude, Gemini and others was considered. Rejected: using consumer free tiers programmatically breaks their terms, quotas exhaust in hours under an observer's load, a provider can change the quota any day, and small local models are not good enough to orchestrate and do not run on most devices.
  
2. Accepted instead: cheap cloud flash models with aggressive prompt caching, user-supplied keys for a tested model list, and CLI subscriptions where the user has them.
  
### 10.5 Spend and safety of the brain
1. Ceilings are settings: per call, per hour, per day. Breach pauses background work and asks. The grounded bar keeps working; only background work pauses.
  
2. "Stop all model activity" switch. Persists across restart.
  
3. Fallback ladder across doors. A failed door shows a banner, never silence.
  
4. Cloud calls go only to providers with zero-retention policies, pinned per model. Open-weight models are self-hosted when volume justifies it. Only the prompt leaves the device; the store never does.
  
## 11. Capture and storage
### 11.1 Sources
Free methods only. Official APIs, exports, open protocols, local files and databases, the SuperTwin browser, and the phone's own permissions. No paid APIs. No private-API scraping libraries on real accounts.

| Group | Sources | How | Phase |
| --- | --- | --- | --- |
| Messages | WhatsApp | linked device (whatsmeow), QR pairing, history + live, token-gated send | 1   |
| Messages | iMessage, SMS | Mac Messages database; send via the Messages app through the computer hand; Android SMS natively | 1 (read), 2 (send) |
| Messages | Slack, Instagram DMs, X DMs | API where free, else export + SuperTwin browser | 1 (Slack), 3 |
| Mail | Gmail, other IMAP, the twin's own email | Gmail API or IMAP, labels, threads | 1   |
| Notes | Apple Notes, Google Keep, Notion | local DB / API / export | 1 (Notion), 2 |
| Tasks & time | Apple Reminders, Google Tasks, Google Calendar, Apple Calendar | EventKit / API | 1   |
| Docs | Google Drive, Docs, Sheets, Slides | Drive API, change feed | 1   |
| Web | Browser history, bookmarks, open tabs, page text | local history DBs of every installed browser, every profile | 1   |
| Social | Instagram saves, posts, reels · X bookmarks, posts · YouTube history, saved · TikTok bookmarks | export first, then SuperTwin browser at human cadence | 2   |
| Screen | accessibility tree of the front window, screenshots for AX-poor apps, screen attention, system audio | screen recorder daemon on Mac; accessibility service on Android | 1   |
| Ambient audio | 24x7 mic on Mac and phone | local whisper, on by default with permission, one-key off | 1 (Mac), 2 (phone) |
| Calls | calls through the twin number, outbound calls, screened inbound, Android calls with consent | call agent transcripts | 2   |
| Meetings | video calls, meeting transcripts | system audio + mic, local whisper, speaker separation | 2   |
| Keyboard | everything typed, including drafts never sent | keyboard extension on iOS and Android, secure fields excluded by the OS | 2   |
| Notifications | every notification on Android | notification listener | 2   |
| Mobile | screenshots, share sheet, clipboard, location, health, contacts | mobile apps | 2   |
| Self inputs | Scratchpad, voice input, clipboard, Mouse Helper, AI keyboard | built in | 1, 2 |
| Commerce | Amazon, Blinkit, Zomato, Swiggy, MakeMyTrip, Uber and others, any country | order mails and SMS first, then browser order history | 2   |
| Entertainment | Netflix, Spotify, YouTube, BookMyShow and others | export / browser history | 2   |
| AI chats | Claude, ChatGPT, Gemini | file watch / export | 2   |
| Other twins | scoped messages from twins in Together mode; taste channels subscribed to | protocol | 2   |
| Self | everything the user does inside SuperTwin | built in | 1   |

1. Each source declares: how far back it can go, live or poll, and which hand it uses.
  
2. Each source has its own Index and Understand windows. Widening a window later replays stored events. Never a re-import.
  
### 11.2 Input methods
Ways the user pushes things in. Every one produces a normal event that flows down the one path. Nothing lands in a side bucket.

1. **The grounded bar.** Typing or speaking to the twin is the richest input of all, and the only one with no ambiguity about who is speaking: first person, present tense, stated on purpose. It creates things directly (§16.1) and everything else it contains is extracted like any other event.
  
2. **Apps.** Share sheet on Mac and phone. Share anything to the twin.
  
3. **WhatsApp, iMessage, twin email.** Message your own self-chat or the twin's address. Text, voice, photo, forward.
  
4. **Clipboard.** A source like any other. Every copy is an event, after the filter. Copies from password managers and secret fields never enter.
  
5. **Screenshot.** Any screenshot is an event. It is read (OCR plus vision), filed, and shows in Scratchpad as a view.
  
6. **Voice input.** Hold a key, speak, release. Works in any app. Dictation with intent: "add milk to groceries" does it.
  
7. **Ambient voice.** Always-on mic, local transcription, speaker separation. On by default after permission. Off with one key, from the bar, the menu bar, or the phone's live activity.
  
8. **Mouse Helper.** Drag a box around anything on screen. It takes a region screenshot plus the accessibility text under it. The menu appears instantly with fixed actions: Save, Add to space…, Ask…, Copy text. No model call to show the menu.
  
9. **Keyboard.** The twin's keyboard on phone with voice input. Suggestions and autocomplete from the twin's memory.
  

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
### 11.3 Three hands: connectors, browser, computer
Every source and every action uses one.

1. **Connectors.** APIs, exports, open protocols, local files and databases. First choice. Fast, safe, cheap, free.
  
2. **Browser.** The SuperTwin browser (§11.4). For sites with no API and for acting on the web.
  
3. **Computer.** Accessibility and input control of native apps. When there is no API and no web. Same rules as the browser.
  
4. Rules for browser and computer, code-enforced: read at human cadence with jitter and random skips; never automate login, OTP or 2FA, the user logs in once, visibly; stop and notify on any challenge, captcha or checkpoint page; agent tabs and windows never touch the user's own; every agent session is logged step by step and can be replayed.
  
### 11.4 SuperTwin browser
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

1. **Engine.** Bundled Chromium, headed but hidden, driven over the Chrome DevTools Protocol. Never headless mode.
  
2. **Logins.** On first run the browser imports cookies, sessions, passwords and bookmarks from the user's main browsers, with permission, using Chromium's own import. Where import fails, a one-time visible login inside the SuperTwin browser. Never our own cookie decryption.
  
3. **Eyes.** Accessibility tree distilled to salient elements with stable ids. Set-of-marks screenshots as fallback.
  
4. **Hands.** A thin CDP harness exposed to the model as tools. Click, type, scroll, select, upload, download, open tab, wait.
  
5. **Memory.** Per-site skills the agent writes after the first success. Captured network endpoints: learn a site's own JSON calls once, then poll them in-page with the site's own cookies. Local mirrors with incremental cursors.
  
6. **Capture.** Reads YouTube history, X bookmarks, Instagram saves and similar in the user's own session at human cadence, incremental, stop at last seen.
  
7. **Execution.** Agent tabs run tasks: compare, fill, cart, up to the gate. The gated step runs in a webview card inside the app.
  
8. **Webviews.** Any card or answer can embed a live page from this browser.
  
9. **Replay.** Every agent session stores its step log with a screenshot per step. Replay is a step-through, not a video.
  
10. **Kill switch.** Visible. Stops every agent tab at once.
  
### 11.5 Data filter
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
  
7. Anything hidden from a taste channel never leaves the device.
  
### 11.6 Capture by platform
1. **macOS.** Accessibility tree of the front window, screenshots for poor apps, system audio and microphone, Messages database, mail via IMAP or API, every browser's history, clipboard, files, the SuperTwin browser, the computer hand. The deepest observer.
  
2. **iOS.** Microphone through the background audio mode, started in the foreground and shown in a Live Activity; the custom keyboard with Full Access, where the OS itself excludes password and payment fields; share sheet; screenshots and the photo library; location always; calendar, contacts, reminders, health; mail via IMAP; WhatsApp through a linked device on the Mac or the own cloud; calls through conditional forwarding of unanswered and declined calls to the twin number, because iOS will not let an app answer calls; Shortcuts automations; Siri App Intents; Apple Watch and AirPods as ears.
  
3. **Android.** The notification listener, which is the richest observer channel on any phone; call screening natively; SMS for transactions; microphone; location; optional accessibility service; share sheet; keyboard.
  
4. **Windows.** Later, mirroring macOS.
  

```
              MAC                    iPHONE                   ANDROID
   ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐
   │ screen AX + shots    │ │ mic (background)     │ │ notifications (all)  │
   │ mic + system audio   │ │ keyboard (typed)     │ │ call screening       │
   │ Messages DB          │ │ share sheet · shots  │ │ SMS · mic · location │
   │ browser histories    │ │ location · health    │ │ accessibility (opt)  │
   │ clipboard · files    │ │ calendar · contacts  │ │ share sheet · keyboard│
   │ SuperTwin browser    │ │ calls via forwarding │ │ calls natively       │
   │ computer hand        │ │ Shortcuts · Siri     │ │                      │
   └──────────┬───────────┘ └──────────┬───────────┘ └──────────┬───────────┘
              └────────────────────────┼────────────────────────┘
                                       ▼
                        one event log, synced, signed, encrypted
```
### 11.7 Unrecoverable data
1. **Unrecoverable data** is data that exists only if captured at the moment it happens: no service stores it, so no later entrant can sync it. Every other source can be re-pulled by any competitor the user authorizes. Tenure of unrecoverable data is the one memory asset that compounds.
  
2. The list, all captured with consent and processed locally:
  
3. Ambient audio: conversations in rooms, meetings, what the user says out loud.
  
4. Both sides of phone calls that go through the twin's number, and on Android any call with consent.
  
5. Screen with attention: what the user actually read and for how long, which message was opened and not answered, which reel was lingered on.
  
6. Notifications on Android: every message across every app as it arrived, including WhatsApp messages later deleted for everyone, disappearing messages, view-once media previews and Instagram DMs.
  
7. Text typed and never sent, through the keyboard.
  
8. Clipboard history.
  
9. The full location trail with semantic context, now that Google keeps Timeline on-device and deletes it after a few months by default.
  
10. Ephemeral media viewed: stories, vanishing messages.
  
11. Who the user was physically with, from proximity to family and friends' twins.
  
12. Abandoned intents: carts left, forms half-filled, searches with no click.
  
13. The twin's own history: every action, approval, correction and rule, which is how it knows how the owner likes things done.
  
14. Why the giants will not follow: Meta built disappearing messages and view-once; Apple built ephemerality and on-device-only; their agents cannot be the thing that defeats their own privacy features. A cloud agent that ships this volume to a datacenter pays for it in inference and in liability and must sample.
  
### 11.8 Storage
1. One append-only event log in SQLite. The original payload of every event is kept as received. Long text is stored compressed on disk; it reads back unchanged.
  
2. Full-text search and chunk embeddings over everything indexed.
  
3. Screen text stored as anchor plus diff.
  
4. **Two disk budgets, because media dwarfs everything else.** Measured: the event log with indexes and full-text search costs about 1,330 bytes an event, about 0.5 GB a year with every first-phase source on. WhatsApp media alone runs about 2 MB a file, 11 files a day, about 8 GB a year. So: events and derived data, default 2 GB a year; media, default 30 GB with its own retention window, thumbnails only past 90 days. Both settings. The Library shows use per source against each.
  
5. Ambient audio is never stored as audio by default; only transcripts, speaker labels and timing. Audio retention is a setting, off by default.
  
### 11.9 Encryption
1. Sync to phone and servers is by signed, encrypted messages over the wire (§23.4).
  
2. At rest: plain files in the first phase so the database and logs can be inspected and debugged; encryption at rest with user-held keys arrives with the own-cloud image, where it is mandatory, and becomes the default on devices after that. "Local" is never marketed as "encrypted" until it is.
  
## 12. Understanding
How captured events become a world model: episodes, spaces, tasks, people, claims, taste. The same machinery runs for history and for live data; the differences are order, speed and what is allowed to surface (§12.2, §14).
### 12.1 Streams and tiers
A **stream** is where events happen: one chat, one app session, one domain on one day, one document, one mail thread, one call, one room of conversation. Streams are structural. They say nothing about topic.

| Tier | Streams | Processing |
| --- | --- | --- |
| 1   | DMs and groups the user has ever replied in. Everything the user actively does. Rooms the user speaks in. | Full, live |
| 2   | Businesses the user transacts with and that send updates: orders, OTPs, bookings, bills | Full, transactional extraction, live |
| 3   | Groups and DMs the user is in but never replied to. Businesses interacted with in the past, no active relationship | Coarse digest, one week per call, only weeks with new events, later |
| 4   | Marketing and spam from businesses the user never interacted with | Index only, searchable, never understood unless promoted |

1. **Promotion.** Any engagement promotes a stream: a reply, a click, a save, a reaction. Promotion is instant and retroactive: the stream's history is re-processed at the new tier.
  
2. Tier is decided by code where possible (did the user reply), by a cheap cached model call for the business split.
  
3. Misclassification costs latency, never data.
  
### 12.2 Processing order: history and live
The system processes two kinds of data with one pipeline: **backfill**, the history that exists when a source is connected or a window is widened, and **live**, events arriving now. They share understanding, memory, the critic and the world model. They differ in three ways.

|     | Backfill (history) | Live |
| --- | --- | --- |
| Unit of a call | one calendar day of one source, split at 30k chars at the largest inactivity gap | a bundle: a few minutes of life across all sources |
| Order | newest day first, tier 1 then 2 then 3 within a day, chats then screen then browser | as it happens; hot events flush now |
| May nudge | never | yes, the only lane that can |
| May start executors | only scheduled recurrences it discovers | yes, executor-lite and full tasks |
| Yields | the full picture marked as history: dormant spaces, closed tasks, claims, patterns, relationships, life narrative | current state, tasks, prepared actions, cards |
| Concurrency | uses whatever slots live leaves | reserved slots, always first |

```
  LIVE ─────────────────────────────────────────► always first, reserved slots
  HISTORY  newest day ► older days
           within a day:    tier 1 ► tier 2 ► tier 3
           within a source: chats ► calls ► screen ► browser ► rest
           within a tier:   engagement × recency (an ordering signal only)
  USER PIN ─────────────────────────────────────► jumps the queue
```

1. Pin anything: a source, a chat, a sender, a mail address, a website, an app, a folder.
  
2. Old history yields the full picture, marked as history. Old items are never surfaced as active or due. They make the twin know the user.
  

| Age band | Yields | Surfaced as active |
| --- | --- | --- |
| 0–30 days | everything | yes |
| 1–6 months | spaces, tasks with still-open evidence, claims, recurrences | only verified-open tasks |
| 6 months–2 years | dormant spaces, closed tasks, claims, CRM, recurrences, life events | no  |
| 2 years + | coarse claims, relationships, narrative | no  |

3. A recurrence detector runs across all bands. Last year's insurance renewal becomes next month's task.
  
4. History output never reaches a nudge surface. Enforced twice: the history prompt has no live section, and code discards any live output outside the live lane.
  
### 12.3 Bundles, episodes, context
**The unit of a live model call is time, not stream.** A **bundle** is a few minutes of life across all sources. The **state gate** is the sub-100 ms lookup that decides whether an event flushes now or waits.

```
  event ──► world-model lookup (code, no model call, <100 ms)
              open task in this stream? · active episode? ·
              bridge to an active space? · entity in an active space? ·
              addressed to the twin (bar · self-chat · voice input · twin email)?
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

1. **Why the gate is a lookup, not a judgement.** No code rule can tell whether an "ok" matters. Character counts and intent keywords are syntactic proxies for a semantic property and are wrong exactly where it matters: "ok" closing a ₹50k payment and "ok" acknowledging a joke are identical bytes. But the world model already knows whether a task is waiting in that stream, and asking it is a lookup. That is the only thing code decides.
  
2. **Why a burst is a lookup.** Five distinct product pages on one domain in three minutes is not a claim about meaning. It is a count of engagement read off the log. It fires once per new engaged topic, the live call creates the space, and from then on every event in that stream is hot.
  
3. **Bootstrapping.** A new user has no tasks, so nothing is hot. While the world model is sparse (under ~20 spaces, or the first 7 days) the cold window runs at 60 s idle / 180 s max, then widens.
  
4. **The packer.** A small bundle is never context-starved. The bundle is the delta; the call sees the delta plus context packed by code: thread history bounded by the stream's open episode plus a short run-up, quoted and replied messages however old, capped at ~1,500 chars per stream and 5 streams; open and recently dormant episodes; candidate spaces from retrieval, at most 5, with exemplar episodes; open tasks and the calendar for the next days; the roster of resolved people; related cross-source episodes via bridges and entities; the current time.
  
5. **Thin context stops the pass.** If the packer cannot assemble enough, the bundle is held for the next flush or sent with an explicit "insufficient context" instruction that permits only `unsorted` plus a question. It never permits a guess.
  
6. The packer's retrieval is T0 only (§26.4): local, no model call, ~150 ms. It never escalates.
  
7. **Cost.** Measured on 63 days of real WhatsApp data with screen and browser modelled on top: a plain 45-second idle rule fires 474 times a day once screen is on. The state gate fires 147 times, hot events land in 43 seconds at median, and the burst condition adds roughly one call per new engaged topic, about 160 a day. On flash-class models that is under $3 a month.
  
8. **Episodes.** The model cuts a bundle into **episodes**: one burst of activity about one thing in one stream. Episodes chain across time. A flush boundary is not a burst boundary; continuity is carried by episode `join` actions and chaining, never by where the cut fell.
  
9. **Episodes and spaces.** All chained episodes about one topic file into the same space. The episode is the evidence unit inside one stream. The space is the goal across all streams.
  

```
   stream wa:goa-gang      ep_412 ─ ep_530 ─ ep_611   (chained: villa talk over 3 weeks)
   stream browser:airbnb   ep_418 ─ ep_533
   stream screen:goibibo   ep_419
   stream room:dinner      ep_640   (heard: "Hampi in October?")
                              │        │        │        │
                              └────────┴────────┴────────┘
                                       ▼
                        SPACE  Goa trip with Rohan in December
                               └─ milestone Stay
```

10. Every episode lists its events. Every episode goes to a space or to unsorted. Unsorted is reviewed at every space birth and weekly.
  
11. A **critic** grades every write before commit. A wrong merge destroys. A wrong split repairs.
  
### 12.4 Memory system
Layers are storage. Kinds are what a memory means. A memory has one layer and one or more kinds.

```
  LAYERS                                    KINDS (tags on any memory)
  ┌────────────────────────────────┐        ● emotional    the feeling attached
  │ 6 WORKING   running tasks      │        ● prospective  a future intention
  ├────────────────────────────────┤        ● behavioral   changes how the twin acts
  │ 5 PROCEDURAL workflows · how-  │        ● narrative    the life arc it belongs to
  │   tos · skills · tone · habits │        ● shared       belongs to a relationship
  ├────────────────────────────────┤        ● identity     who the user is
  │ 4 IDENTITY  life story · CRM · │        ● taste        what the user consumed and loved
  │   card · address               │
  ├────────────────────────────────┤
  │ 3 SEMANTIC  claims · entities  │
  ├────────────────────────────────┤
  │ 2 EPISODIC  episodes · spaces ·│
  │   tasks · calendar · ledger    │
  ├────────────────────────────────┤
  │ 1 ARCHIVE   events · FTS ·     │
  │   embeddings · coverage        │
  └────────────────────────────────┘
```

1. **Procedural** holds workflows (how the user does recurring things), how-tos (how to do a thing on a site or app, written by the twin after a success), skills, per-person tone, habits.
  
2. **Emotional.** A feeling tag on an episode or claim: joy, stress, dread, pride, annoyance. Inferred from words, reactions, timing, prosody in audio. Used to set tone, timing and priority.
  
3. **Prospective.** A future intention: "want to try Hampi trek", "should call the dentist". Has a horizon. Unresolved after N days (default 30) it downgrades to dormant, then archived after 90. It wakes on any new signal.
  
4. **Behavioral.** Rules that change how the twin acts: "don't nudge on YouTube", "always Hinglish with Rohan", "ask before ordering over ₹2k". Written from feedback. Shown and editable in Settings › Assist.
  
5. **Narrative.** Life arcs: "moved to Bengaluru 2022", "building v13". Every space and many episodes belong to an arc. The narrative is the story of the user's life, rendered as the life story.
  
6. **Shared.** A memory that belongs to a relationship: inside jokes, shared history, plans made together, a running tab. Held in the CRM card. In Together mode, visible to both twins only if both owners allow.
  
7. **Taste.** What the user consumed, saved, visited, bought, read, watched, with domain, timestamp and reaction. Feeds taste channels (§18).
  
8. **What the user says feeds all of these.** One utterance can write to several layers at once.
  
9. **Consolidation** runs on change, not on a clock: dedupe at write; merge and split over what was written since the last pass; a deep pass when idle. Nothing is deleted. Old claims get an end date. Old working memory is summarized; the full log stays on disk.
  
### 12.5 People: roles, resolution, entities, circles
**Roles per message.**

```
  sender ─► audience (who can see) ⊇ receiver (who it is addressed to)
                       ⊇ mentioned receiver (named, in audience)
            mentioned third party (named, not in audience)
```

**Resolution ladder.**

1. Structural, code, confidence 1.0: sender, audience from membership or headers, platform mentions, reply and quote chains, caller id, speaker labels from audio matched to known voices.
  
2. Roster: resolved identities, relationships and nickname notes injected into every prompt.
  
3. Roster plus retrieval: an unknown name pulls candidate people from the entity store.
  
4. Model: plain-name mentions, pronouns, receiver inference in groups, with confidence.
  
5. Code again: mentioned receiver versus third party is a set-membership test. Never the model's job.
  
6. Unknown beats wrong. Low confidence gives `unknown` plus a question.
  

**Entities and provisional people.**

1. Any resolved-enough mention creates a **provisional person**: name plus context anchors, no identifiers needed. A cousin, a kid, "Priya's landlord".
  
2. Provisional people merge forward when identifiers or confirmations arrive. A provisional person who joins the network claims their record (§29.2).
  
3. Merge and split people by drag in People. Undo always.
  

**Circles.**

| Circle | Examples | Effect |
| --- | --- | --- |
| partner |     | highest priority, longest lead times, warmest tone, widest default scopes |
| family | parents, siblings, kids | plan ahead for dates, act on their asks, verified calls |
| close friends |     | plan ahead, casual tone, taste subscriptions by default |
| friends |     | wish on dates, follow up on plans |
| coworkers |     | work tone, work hours |
| services | doctor, plumber, school | transactional, call-able, pass the inbound gate with instructions |
| old batchmates, acquaintances |     | wish only, low nudge priority |
| business, active | user transacts, they send updates | extract orders, bills, bookings |
| business, past | transacted once | history only |
| business, marketing | never interacted | index only; may reach the twin only via the market |

1. Circles are inferred from content, tone, claims and metadata. A quiet family group outranks a chatty acquaintance group.
  
2. Circles drive processing priority, drafting tone, nudge thresholds, lead times, whose tasks are the user's, inbound gate defaults, and default scopes in Together mode.
  
3. User-editable by drag.
  

**Address and tone memory.** See §8.5. Address terms are classified discriminating (a stable unique mapping) or generic ("bro", "boss", "yaar"). Generic terms feed tone, never identity.

**Applicability.** "Everyone must submit by Friday" in a 200-member group the user never replied in is almost never the user's task. The same words in a 5-person project group are. Tier, circle and engagement ride in the prompt for exactly this.
### 12.6 Time resolution
```
  MESSAGE TIME     when it was said         → resolve relative dates ("tomorrow", "next Friday")
  PROCESSING TIME  when the twin read it    → decide if the resolved date is past or future
  VIEW TIME        when the user looks      → render "in 3 days", "2 days overdue"
```

1. Relative expressions resolve against the message time, stored absolute with timezone, original phrase kept.
  
2. At processing time a resolved date in the past is closure-checked, never surfaced as due. A date in the future becomes a real due date or calendar item.
  
3. Backfill: "book by tomorrow" in a message from March resolves to a March date, is checked against later evidence, and closes or asks.
  
4. Recurring phrases become rules on the calendar, not single dates.
  
5. The view renders relative to now. Nothing relative is stored.
  
6. Timezones follow the user's location at message time.
  
### 12.7 Personal CRM
1. One card per person, including provisional people.
  
2. Card: profile fields, relationship, circle, last context, open loops, their goals and spaces, their narrative, their voice, shared memory, scopes granted and received, their public spaces and taste channels if they have a twin, verification level.
  
3. **Follow-up radar.** Who owes the user a reply, who the user owes. Each with a follow-up time and a lead time for the twin to start acting. Defaults by circle, learned per person.
  
4. **Dates.** Birthdays, anniversaries, exams, flights. For each: plan or wish. Plan means a space opens at T minus lead time (default 14 days for partner and family, 7 for close friends). Lead time and mode are per circle, per person, learned, snoozable.
  
5. Business cards carry orders, bills, bookings, tickets, support history, and whether the business has a twin.
  
### 12.8 Calendar
```
  sources ──► Google/Apple calendars · chat-derived events · booking mails · reminders ·
              tasks with due dates · twin's scheduled steps · recurrences · people's dates ·
              heard plans ("dinner Saturday?") · other twins' confirmed plans
                                        │
                                        ▼
  ┌──────────────────────── Calendar ─────────────────────────┐
  │ layers:  ◼ my events   ◻ my tasks   ◆ twin's tasks   ● people │
  │ views:   month · week · day · agenda                       │
  │ uses:    conflicts · travel time · lead times · quiet hours │
  └────────────────────────────────────────────────────────────┘
```

1. Every layer can be shown alone or together.
  
2. Lead-time planning: an event on the 10th opens its planning space on the 10th minus the lead time. Snoozes are learned.
  
3. The twin schedules around the calendar: free slots, travel time, quiet hours for when the twin acts in the world, the user's usual times.
  
4. Chat-derived and heard events appear as tentative until confirmed by the user or by a booking.
  
5. Writes back to Google or Apple calendar when the user wants.
  
### 12.9 Spaces
A **space** is one goal. It is the unit of organization and of action. It runs in a loop until the goal is met.

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
          ├─ TASTE       4 Anjuna places from Tanvi's food channel · 2 from yours
          ├─ ENRICHMENT  fares · villa availability · weather · events in Goa that weekend
          └─ EVIDENCE    episodes from WhatsApp · browser · screen · mail · dinner (heard)
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
  
2. Goals are inferred from intent, money, dates and repetition. The user edits the label and the goal.
  
3. Space properties: state (active, dormant), horizon (short-term, long-term), life (permanent, ephemeral), cycle (one-time, recurring), access (private, shared with named people, circle, public), players (solo, collaborative).
  
4. Space types are open-ended and carry no template. The plan is written for this user, from this user's history and habits. **Learning spaces**, spaces whose goal is to understand a topic, are a common type and the source of public learning pages (§18.5).
  
5. **Enrichment** pulls whatever helps the goal: web data (prices, availability, hours, weather, news, reviews), user data (past trips, past orders, related people), and taste from subscribed channels. Refreshes are fetches compared by content hash in code; the model sees an enrichment only when it changed.
  
6. Cross-source joins happen in the space. A chat, a page, a screen, a mail and a heard conversation about one trip meet here.
  
7. Milestones exist only when the goal has stages.
  
8. Try lists and bucket lists are prospective memories that seed dormant spaces. They wake on a signal.
  

**Space birth.**

```
  INFERRED   Decide sees goal evidence ─► propose-only mode? ─ yes ─► review queue ─► user approves
             (intent · money · dates ·                       └─ no ──► created, announced
              repetition across ≥2 sources)
  ASKED FOR  user says it in the bar ─────────────────────► created instantly, never proposed
  WOKEN      dormant space or prospective seed gets a signal ─► reactivated with its old evidence
  SHARED     another twin invites the user's twin ─────────► appears under Needs you, one tap joins
                                                  │
                                                  ▼
                                          THE SWEEP (all four)
```

1. **Propose-only mode** is the default for the first weeks: the twin proposes, the user approves. It graduates to auto-create after two clean weeks. A space the user asked for is never proposed.
  
2. **The sweep** runs at every birth: retrieval over unsorted and the log pulls related past episodes into the new space.
  
3. **Birth is deduped.** A candidate that near-matches a live space becomes an attach, or a merge question. Never a second space with the same goal.
  
4. **Unsorted is not a grave.** Episodes with no space wait there, are re-reviewed at every birth and weekly, and archive after 30 days, still searchable.
  
### 12.10 Space list and view
1. **List.** Grouped by life area or by arc. Sort by activity, deadline, or pin. Dormant collapsed.
  
2. **Row.** Label, area, summary line, next action, task count, freshness, people chips.
  
3. **View.** Goal, summary, latest at top. Plan. Milestone rail if any. Tasks. Prepared artifacts. Taste. Enrichment. People. Evidence timeline.
  
4. Every element opens a "why" panel: evidence quotes, confidence, trace.
  
5. Drag an episode or task to another space to correct filing.
  
### 12.11 Tasks
1. **Explicit.** The user or someone else said it.
  
2. **Implicit.** Entailed by what happened. "Flights booked" entails "web check-in".
  
3. **Suggested.** From plan gaps. Marked as suggested. No cap.
  
4. Types are open-ended: research, compare, message, call, follow-up, shopping, booking, form, filing, monitoring, errand, creation, reminder, payment, return, refund, cancel, renew, schedule, post, brief, negotiate.
  
5. Steps depend on the task: gather context, research, compare, draft, fill, call, book, verify, report, wait-until.
  
6. **Scheduled steps.** "Bookings open at 10 am tomorrow" becomes a wait-until step at 09:55. The scheduler wakes the task. The task is never dropped.
  
7. **Follow-up tasks.** When a task closes, the twin proposes and schedules the next ones.
  
8. Owner is resolved from roles. Another person's task becomes a monitoring item or a follow-up for the user.
  
9. **Closure.** Hard evidence closes: a receipt, a confirmation, both sides saying done. One-sided intent is not closure; it makes a check at the expected time. Past due with no evidence, the twin asks "done?" with one tap. Repeated silence downgrades to dormant, never deletes. Cancellation closes as cancelled, never as done.
  
10. **Run state, task state and wake state are separate.** A worker run ending never marks a task done; a task done never removes a future wake by itself.
  
### 12.12 Prioritized task list
1. One list across all spaces. Score: deadline, gate needed, value, effort, emotional weight, waiting parties, user pins.
  
2. Row: title, space chip, people chips, due, status, one-tap action.
  
3. Sections: Needs you → Today → This week → Later → Waiting on others → Done today.
  
4. Filter by life area, space, person, type, gate. The twin explains the order on hover. Reorders are learned.
  
### 12.13 Claims and traits
1. Kinds: fact, claim, belief, value, preference, interest, like, dislike, fear, opinion, recommendation, try-list item, pattern, habit, workflow, relationship, feeling, taste.
  
2. Recommendations carry a type: place, activity, recipe, product, book, show, film, music, service, person, course, app.
  
3. Patterns across time: monthly rent, Friday dinners, annual renewals, gym streaks.
  
4. Workflows: how the user does recurring things. The twin learns them, writes a how-to, and offers to run them.
  
5. Every claim: subject, kind, evidence quote, confidence, valid from, valid to, supersedes, superseded by.
  
6. **Typed fields** where the claim carries them: amount, currency, date, status, merchant, order id, location, duration. This is what makes structured retrieval possible.
  
7. **Self-reported beats inferred.** A claim from the user's own words carries `self_reported` provenance. When the two contradict, the judge supersedes the inferred claim.
  
8. Contradictions never overwrite. A judge decides: supersede or coexist.
  
9. Ads are never preferences. Jokes are tone, not beliefs.
  
## 13. Execution
```
   task ─► CONTEXT ─► PLAN ─► [ step ─► verify ]─┐ not met ─► replan (or retry if transient)
              │         │           ▲             │
              │         │           └─────────────┘
              │         │                        met
              │         │                         ▼
              │         │              gated step left?
              │         │             no ─► done ─► FOLLOW-UPS ─► plan update ─► LEDGER
              │         │             yes ─► approval card ─► tap ─► run ─► done
              ▼         ▼
        unsure or missing? ─► one combined question card ─► pause (task waits, others run)
                                                       step has a time? ─► scheduler wakes it
```
### 13.1 Context collection
1. The executor packs whatever helps: space state, plan, open tasks, claims, people, calendar, recent episodes, past attempts, how-tos, skills, taste, and web context.
  
2. Retrieval, not enumeration. Top matches with quotes. Prompt size stays flat. The executor is the natural home of T2 agentic retrieval (§26.4).
  
3. **Questions.** Missing information becomes questions, combined into one card with fields. Information the twin has but is unsure of is prefilled with "confirm?". The task pauses only for that card.
  
4. **Thin context stops the executor.** The person resolved, the date absolute, the amount known, the account identified. Anything thin becomes a question. An executor that acts on a guess and succeeds is still a defect.
  
### 13.2 Planning and steps
1. Plan first. Write acceptance criteria before acting.
  
2. A step can be scheduled or wait on a condition (price below X, seat available, reply received) with a polling plan and a stop. A poll is a fetch and a compare in code. The model is called only when the polled value changes.
  
3. The gated step is placed last wherever the task allows. Where it must come earlier (a deposit before a viewing) the plan splits.
  
4. Plans are visible and execute on their own. The user steers by feedback and chat on the task: "not IndiGo", "morning only".
  
### 13.3 Execution with model, tools, skills, browser, computer
1. Loop: step → verify against criteria → next. Retry unchanged only on transient failure. Otherwise change the step or the plan.
  
2. Tools are for the world: world-model read and write, web fetch, browser, computer, files, calendar, mail, messaging, calls, connectors, other twins, and any MCP tool or open skill the user adds.
  
3. A missing tool: replan without it if the goal allows; otherwise ask the user to connect it, with a one-tap link.
  
4. **Skills: author, replay, repair, refresh.** After the first success on a site or task type the twin authors a how-to: steps, stable selectors, endpoints, waits, traps. The next run replays it with no model call. When a replay breaks the twin repairs it once and refreshes the how-to. Skills are visible, editable, and shareable to the open ecosystem with private data stripped.
  
5. Browser: agent tabs in the SuperTwin browser's own profile. Computer: native apps through accessibility, same rules.
  
6. Budget per task: cycles and money. On exhaustion: best partial, the gaps, the next idea, and a one-tap "extend budget".
  
7. Gated steps are code-gated. The send and pay paths refuse without a single-use approval token signed by the user's SuperTwin ID.
  
8. **Result contracts.** A worker returns a typed result with evidence: final confirmation page or number, not a pre-final review page. A run that ends without final evidence leaves the task open.
  
### 13.4 The two approval gates
| Gated | Not gated |
| --- | --- |
| Sending a message, mail or call to a private person | Sending to a business, support, a bot, a booking form, another twin within scope |
| Moving money: pay, transfer, subscribe, refund to a card | Carting, filling payment details up to the pay button |
|     | Posting to a public space the user marked auto-post |

1. Everything not gated runs autonomously.
  
2. Public posts carry a soft third gate: approved one by one by default, removable per space.
  
3. A gate produces an approval card with exactly what will happen. One tap mints the signed token. An old approval never authorizes a new action; a token is bound to recipient, amount and payload.
  
4. Behavioral memory can add gates ("ask before ordering over ₹2k") but never remove the two hard ones.
  
### 13.5 Channel of the gated step
| Action | Channel |
| --- | --- |
| WhatsApp send | linked-device daemon with token |
| iMessage send | Messages app via computer hand |
| Mail send | mail connector with token, from the user's or the twin's address |
| Web payment | webview card in the app, user completes on the page |
| In-app payment (UPI and local rails) | phone app, user completes in the payment app |
| Call to a person | call agent dials only after the tap |
### 13.6 Working memory and scratchpad
1. Each running task has a scratchpad: findings, drafts, links, screenshots, attempt log.
  
2. The user's Scratchpad is a view of everything the user pushed in, each already an event on the main path.
  
3. Working memory is kept after completion. After 30 days it is summarized; the full log stays on disk.
  
### 13.7 Follow-ups
1. Completion triggers a next-step pass. Follow-ups are created and scheduled.
  
2. Reminders, checks, monitors, cabs, thank-you notes, reviews and returns are follow-ups.
  
3. The outcome feeds memory and the ledger. A finished trip updates preferences, people, patterns, taste and the narrative.
  
### 13.8 Calls
The twin makes and receives phone calls on the user's behalf.

```
  outbound: task needs a call ─► script + goals ─► dial from twin number ─► talk · hold · IVR
            ─► transcript ─► result card ─► follow-ups
  inbound:  call to twin number, or forwarded unanswered call ─► inbound gate ─► answer, screen,
            take a message, handle with instructions ─► user decides ─► transcript
  live:     user on a call ─► twin listens (with consent) ─► notes · reminders · "ask about X"
```

1. On the phone through the mobile app and the twin number. On the Mac through the connected iPhone when the user allows.
  
2. Calls to businesses are not gated. Calls to private people are gated like a DM.
  
3. The twin says it is calling on behalf of the user. Transcripts are events. Follow-ups come from the transcript.
  
4. The user can whisper instructions during a call from the phone screen.
  
### 13.9 Commerce
1. The browser hand is the universal commerce rail: the twin goes to the seller's website in the user's own session and places the order up to the payment gate. That covers everything that can be bought online.
  
2. Open commerce protocols such as ONDC, the Agentic Commerce Protocol and AP2 are used where a seller supports them because they are faster and more reliable, never as a requirement.
  
3. Volume pricing is a function of collectives (§21), not of protocols.
  
### 13.10 24x7
1. Instinct's cloud computer works while the user's Mac sleeps. Ours must too: keep-awake as a setting on the Mac, a one-click image on the user's own cloud account for the brain and store, the phone for light tasks, and a home box later. Hands for WhatsApp, Instagram and X stay on residential devices because datacenter IPs are blocked.
  
## 14. Live mode
**Live mode** is the twin acting on what the user is doing right now: understanding a live bundle within a minute, preparing the help before it is needed, and showing finished work as a card on the surface the user is on. No competitor does this, because every competitor is told what to do. It is copyable and it is still the sharpest thing a user can feel on day one.
### 14.1 One path, not two
Live mode is not a separate lane with a separate watcher. It is the live path running end to end. Every live bundle goes through the same understanding, writes the same world model, and triggers the same executor. The difference from history processing is only speed and delivery.

1. **Context.** A separate watcher sees the last seconds. The live path sees thread history, spaces, tasks, claims, people, calendar, taste and time.
  
2. **One write path.** No ungated side channel into memory.
  
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
                                         artifact ─► surface router ─► nudge ─► ledger

  hot path:    43 s median to understood, ~1–4 min to a prepared artifact
  burst path:  ~3 min to understood on a topic with no state yet
  cold path:   9 min worst case, under the 10-minute promise
```

1. **Latency follows state or engagement.** An event touching an open task, an active episode or an active space is understood in well under a minute. An event on a topic the user is actively working through reaches the same call on the burst condition. Only events touching neither wait.
  
2. **Instant help** exists where the user asks: Mouse Helper, the grounded bar, voice input. Those run in seconds because the user chose the context.
  
3. History processing never nudges. The live path has reserved concurrency.
  
4. **Executor-lite** is a bounded executor for prepared actions from the live path: compare, draft, fill, cart, look up, with a small budget and no gate. Anything bigger becomes a task.
  
### 14.3 Surface router
Every artifact, question and approval is delivered where the user is.

```
  presence:  Mac active (screen events < 3 min) ─► nudge on Mac + panel
             phone active                       ─► phone push + app
             neither                            ─► WhatsApp self-chat (or iMessage / mail per setting)
             on a call with the twin listening  ─► whisper on the phone screen
  always:    the artifact also lands on Home › Prepared, the space, the timeline, the ledger
  gates:     approval cards go to every surface the user has enabled for approvals
```

The router decides where, never whether. There is no hold state and no quiet-hours suppression: a card the user is not there to see is routed to a surface they are.
### 14.4 Nudge surfaces
1. **Nudge card.** Top-right on Mac, one at a time, and the same card inside the overlay. Intent line, what I did, artifact peek, Open, Not now. Auto-closes in 60 seconds. Closing loses nothing.
  
2. **Menu bar panel.** Needs you → Prepared → Today. The icon carries an unread counter for cards shown but not opened.
  
3. **Prepared shelf.** Home, the space, the timeline. Same artifact, one status.
  
4. **Grounded bar chip.** When a fresh relevant artifact exists.
  
5. **Phone.** Push, Today list, live activity for running tasks.
  
6. **Chat channels.** A short message with a link to the card.
  
7. **Brief.** At the times set, one card: needs you, today, what moved since the last brief, what the twin number handled. A model writes the prose only when something changed.
  
8. **No cap and no throttle.** Cost is bounded by the card, not by a quota.
  
9. **Merge, don't queue.** Nudges about one space inside a short window collapse into one card.
  
10. **Order by decay.** Help with what you're doing → needs you to finish → something moved → done for you → done in advance → understanding worth telling.
  
11. **Dismissals rank, they do not mute.** Only the user's explicit "don't do this" blocks a kind, reversibly.
  
### 14.5 What qualifies as a nudge
The scarce thing is not the user's tolerance for cards. The scarce thing is the window in which help is worth anything.

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

| Kind | The user gets | Examples |
| --- | --- | --- |
| **Help with what you're doing** | The next step, done, on the thing they are on | Comparison across sites for the TVs being browsed · "you saved this villa in July" · form filled on this page · draft reply for the chat being read · "Tanvi's channel has 4 places here" · "you already bought this in March" |
| **Done for you** | A task they were supposed to do, finished | Check-in done · cab booked · clinic moved · refund filed · groceries carted · bill prepared · 3 calls handled |
| **Done in advance** | Work started before it was needed | Ma's birthday plan started · dormant Hampi space woke for the long weekend · fare dropped on a watched route |
| **Needs you to finish** | The one tap or the one answer | Pay ₹8,400 · send this to Ma · "AC or sleeper?" · login expired · challenge page · budget exhausted |
| **Something moved** | News they were waiting on | Rohan's twin agreed Sat 8pm · Karan replied · Tanvi joined the shared trip · "you owe Sameer a reply", with the draft |
| **Understanding worth telling** | A state change they would want to know | New space started · milestone reached · a new person in the life story |

Everything else is the twin's own bookkeeping and stays inside the app. The boundary is user value versus housekeeping, not urgent versus not urgent.

**Expected volume.** About 160 live calls a day, of which 20–30 produce something the user could see, of which 5–12 earn a card.
## 15. Feedback and learning
```
  edit · drag · dismiss · approve · snooze · "tell the twin" · task chat · keep/hide in taste
        │
        ▼
  correction event ─► world model update (now) ─► behavioral memory ─► golden eval case (later)
        │
        ▼
  effects: filing hints · task thresholds · nudge ranking · tone · lead times · surface choice ·
           inbound gate rules · taste curation
```

1. **Direct manipulation is correction.** Edit a title, drag a task, move a person. Undo chip. No dialogs.
  
2. One menu everywhere: Edit, Remove, Tell the twin.
  
3. **Tell the twin** locks the chat to the object. "This is Karan's, not mine." Applied at once, shown, undoable.
  
4. Quick chips per type: Not mine, Already done, Not true, Outdated, Merge into, Don't do this again.
  
5. Signal weights: explicit feedback > edits > dismissals > views.
  
6. Every correction drafts a golden eval case. No prompt ships that scores worse.
  
7. A correction of a fact writes a typed supersession, never a prose note alone.
  
## 16. Grounded bar, personality, reactions
### 16.1 One bar
1. One input. No modes. The bar understands the input and starts doing what needs to happen.
  
2. **Search.** Instant results while typing. Events, episodes, spaces, tasks, people, claims, artifacts, taste.
  
3. **Chat.** Questions about the user's data are answered from the data, with citations and coverage. General questions are answered by the model directly, marked "not from your data".
  
4. **Action.** "Remind Rohan about the advance" becomes a task with normal gates. "Plan Hampi trek in October" creates a space and sweeps related history in.
  
5. **Correction.** Context-locked when opened from "Tell the twin".
  
6. Lives inside the overlay, floats over the desktop, and is the same brain behind the chat surfaces on WhatsApp, iMessage, the twin email and the phone.
  

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
      ├─ yes ─────► answer with citations and coverage
      ├─ no ──────► T2 agentic loop, budgeted, progress streamed
      └─ general ─► model answers directly, labelled "not from your data"
```

1. Type-ahead is free: local only, under 150 ms.
  
2. One call routes and plans. Code executes the plan.
  
3. Sufficiency is checked in code. A lookup needs a quote that covers the claim. An aggregate needs a complete set. An absence claim needs the whole thread scanned.
  
4. Partial answers say they are partial: "Three so far, I only have WhatsApp back to Jan 2024."
  
5. Escalation streams its progress.
  

**What the bar creates.**

```
  "plan hampi trek in october, tanvi's coming, budget 15k, she's vegetarian"
        │
        ├─ NAMED THING ─► created now, shown now
        │                 space "Hampi trek Oct" · swept 4 related items ✓
        │
        └─ EVERYTHING ELSE ─► the normal live path, within a minute or two
                              person link  Tanvi → this space
                              claim        budget ₹15k          (self-reported)
                              claim        Tanvi is vegetarian  (self-reported)
                              prospective  Hampi trek → now active
```

1. What it can create: space, task, claim, person, calendar event, reminder, follow-up, try-list item, behavioral rule, inbound gate rule, taste curation, and corrections to any of them.
  
2. The named thing is immediate. Everything else is deferred, not dropped. The bar has no private write path.
  
3. The utterance is the evidence.
  
4. Follow-ups stay on the object. "Actually make it November" updates that space.
  
5. A faster front door, never a side door. Speed comes from skipping the inference, never from skipping the checks.
  
### 16.2 Personality
1. Warm, brief, direct. Speaks the user's language mix.
  
2. Shows its reasoning in one line. Never lectures.
  
3. Admits gaps. "Nothing in your data about this. Here is what I know in general."
  
4. Adapts register to the surface: terse in the menu bar, fuller in the space view, casual on WhatsApp.
  
5. Has opinions when asked, built from the user's own preferences, claims and taste.
  
6. Can talk about the owner's life as the one entity that knows all of it: "what did I say to Rohan about Hampi", "how was my week". This is the one form of fun that is native to us, and it is a hypothesis to test, not a pillar.
  
### 16.3 Reactions, emoji, stickers, GIFs
1. When a reaction is enough, react. 👍 to "done". ✅ to an approval. 🎉 to a booked trip.
  
2. Emoji and stickers are valid replies on chat channels, including the owner's own twin-face stickers.
  
3. In drafts for other people, GIFs and stickers match the user's own habits with that person or group.
  
4. Never a paragraph where a 👍 would do.
  
## 17. Communication: the highest-frequency surface
### 17.1 Messaging
1. The twin lives in the user's chats: self-chat on WhatsApp and iMessage as the conversation surface, drafts in the user's voice for every reply owed, follow-up radar, group chat management: summaries, decisions extracted, plans and money tracked from the group's own messages.
  
2. Every forward the user receives is understood: a reel of a cafe becomes a place in the right space and in taste, a link becomes a read-later item, a screenshot becomes evidence.
  
3. The **twin email** is an email address issued to the twin. Anyone can write to it; other assistants can write to it; the twin replies within the inbound gate and files everything.
  
### 17.2 Calls
1. Inbound: the inbound gate screens unknown and unwanted callers, takes messages, handles delivery executives and drivers with the user's instructions, and passes the circle through. On iOS through conditional forwarding to the twin number, on Android natively.
  
2. Outbound: the twin calls local stores for availability and prices, restaurants for reservations, clinics for appointments, customer care for complaints and refunds, vendors for quotes. Calls to businesses are not gated; calls to private people are gated like a DM.
  
3. The **twin number** is a phone number issued to the twin through a telecom partner. The user gives it to everyone they do not fully trust, so the real number becomes friends-and-family only. Every call to it is answered by the twin and transcribed with consent.
  

```
              calls to my real number                calls to my twin number
   ┌─────────────────────────────────┐    ┌─────────────────────────────────┐
   │ family · close friends ─► rings │    │ deliveries · drivers · banks ·  │
   │ unknown, unanswered ─► forwards │───►│ shops · schools · recruiters ·  │
   │ to the twin number              │    │ strangers · other agents        │
   └─────────────────────────────────┘    │        ▼ inbound gate           │
                                          │ answer · screen · instruct ·    │
                                          │ take message · verify · log     │
                                          └─────────────────────────────────┘
```
### 17.3 Coordination with people who have no twin
1. The twin coordinates with any human by email, message or call from its own addresses, signed and declared. It never needs the other side to install anything. Every such exchange is an invitation: the faster path exists if the other person gets a twin.
  
2. The same channels reach other companies' assistants, which all expose email and phone and none expose APIs.
  
## 18. Taste and social capital
### 18.1 The consumption problem
1. The highest-frequency activity on a phone is consuming content on Instagram, TikTok, YouTube, Snapchat and X, and forwarding it to close circles on WhatsApp and iMessage. It produces no outcome for the consumer. Nothing is kept, nothing becomes a plan, nothing earns anything.
  
2. Social capital in the social era came from performance: posting, curating, captioning, being a celebrity. Performance is expensive, so a small minority created and everyone else lurked. The twin removes the cost of performance: a person's taste exists as a queryable asset without them doing anything, because the twin observed it.
  
3. Only an observer on the user's device can build the cross-platform taste graph. Meta sees Instagram, Google sees YouTube, Spotify sees music, Amazon sees purchases. Nobody sees the whole person, and each platform hoards its part.
  

```
   Instagram saves ─┐                                  ┌─► my spaces (plans)
   YouTube history ─┤                                  ├─► my taste channels (giveable)
   X bookmarks ─────┤   twin, on device   ┌─────────┐  ├─► subscriptions I take
   places visited ──┼────────────────────►│  TASTE  │──┼─► matchmaking in context
   purchases ───────┤   observed, not     │  graph  │  ├─► twin-made content
   books, films ────┤   posted            └─────────┘  └─► draws · adoptions · firsts
   forwards in DMs ─┘
```
### 18.2 Taste channels
1. A **taste channel** is a stream of the things one person consumed, saved, visited, bought, read, watched or listened to in one domain, built automatically by their twin from observation, curated by the owner with one-tap keep or hide, and scoped. Examples: food in Bengaluru, AI reading, films, travel, running gear, what a VC reads about fintech.
  
2. Scopes: private, named people, a circle, public, or paid subscribers.
  
3. Domains are inferred and editable. Anything the owner hides never leaves the device.
  
4. A taste channel is a kind of space and lives with public spaces (§20).
  
### 18.3 Giving and taking
1. **Subscribing** is one twin following another's taste channel. The subscriber's twin uses the channel in context: planning Goa pulls the food channels of the three people whose taste in food the subscriber trusts; reading about an industry pulls the reading channels of the two people they follow for it.
  
2. Subscriptions can be as narrow as one domain from one person, and as broad as everything public from a creator. The owner sets what their twin takes, from whom, and what it gives, to whom.
  
3. **Matchmaking** is the twin finding, among people the owner follows or people in their circles, the ones whose taste in a domain predicts the owner's, and the content, places and events they would want because those people wanted them. It runs on channels the owner chose, never on a global algorithm.
  
4. Both directions are visible and reversible. Blocking is one tap.
  
### 18.4 Social capital in the twin world
1. Likes, views and follower counts rewarded performance. The twin world rewards taste that others act on. The measures, each computed by twins on both sides and shown on the card:
  
2. **Draws**: the number of twins subscribed to a person's channels, per domain.
  
3. **Adoptions**: the number of times something from a person's channel was acted on by a subscriber: the place visited, the film watched, the thing bought, the article read. Both twins know, because both observe. This is the like of the twin era, and unlike a like it is proof.
  
4. **Firsts**: being early. Twins timestamp consumption, so "you watched this before it blew up" is verifiable.
  
5. **Match**: taste compatibility between two people in a domain, computed privately with scoped exchange.
  
6. **Trust**: the size of a person's consent graph, meaning how many people granted their twin scopes such as free-busy, location or preferences.
  
7. **Reliability**: how fast and how well a person's twin settles things with other twins and businesses.
  
8. **Reach**: how many people and agents contacted the twin.
  
9. Status is shown in circles and groups, where it means something, and on the card. There is no global leaderboard.
  
### 18.5 Twin-made content
1. **Twin-made content** is a shareable artifact the twin renders from the owner's spaces, channels and ledger: a public page, a short video rendered from HTML, a card, a monthly and yearly recap in the style of Spotify Wrapped but about a life. Trip plans, learning spaces about a topic, comparisons, reading recaps, "what I learned this month".
  
2. The owner posts it to their existing networks. This is how the twin lives inside Instagram, TikTok, YouTube and X without competing with them: it produces the content that showcases the owner's taste and life, and every artifact carries the twin's card link.
  
3. Learning spaces about topics, private or public, are a first-class kind of space and the natural source of pages and videos.
  
### 18.6 Creator twins
1. A **creator twin** is a twin whose public scope is large: it answers fans' questions from what the creator made public, takes requests, and sells taste channels by subscription. Every fan interaction is signed by the creator's twin and shows SuperTwin to the audience.
  
2. Creators earn directly from taste instead of from sponsored posts, and save the hours they spend on repeated questions. They need no payment from us to bring their audiences.
  
### 18.7 No algorithmic feed
1. Nothing is shown to a user because an algorithm chose it. Everything shown from others comes from a named person's channel the user subscribed to, in the context of something the user is doing, or in a digest the user turned on. The twin surfaces work and taste, not content for its own sake.
  
## 19. The network
### 19.1 Definitions
1. **Node**: one person's twin as running software, with identity, keys, memory, brain, hands and addresses, on the devices and cloud the person chooses.
  
2. **Protocol**: the published wire format and rules for twin-to-twin messages: identity, scopes, intents, signatures, cost fields and threads. Like SMTP for mail.
  
3. **Directory**: the service that maps a handle to a public key and a master address, with verification levels.
  
4. **Relay**: the store-and-forward service that holds encrypted twin messages when the two nodes are not online at the same time. It sees ciphertext only. Any relay works; the home box can be one.
  
5. **Numbers**: phone numbers and email addresses issued to twins through telecom and mail partners.
  
6. **Scope**: what a twin may share with another twin, granted per person or circle: free-busy, location, preferences, budget, plan, tasks, artifacts, taste, evidence. Anything else returns "ask my owner" and becomes a task.
  

```
   Aditya's node                 relay + directory                  Rohan's node
   ┌──────────────┐    signed, encrypted    ┌──────────┐    signed, encrypted   ┌──────────────┐
   │ memory · keys│◄──────────────────────►│ ciphertext│◄─────────────────────►│ memory · keys│
   │ scopes for   │                         │ only ·    │                        │ scopes for   │
   │ Rohan: free- │                         │ handle →  │                        │ Aditya: …    │
   │ busy, food,  │                         │ pubkey    │                        │              │
   │ budget       │                         └──────────┘                        └──────┬───────┘
   └──────┬───────┘                                                                    │
          │  email · WhatsApp · call, signed                    email · WhatsApp · call │
          ▼                                                                            ▼
   Karan (no twin) · a Muse · an Instinct · a Townie · a shop · a school
```
### 19.2 Twin-to-twin
```
  Aditya's twin                                   Rohan's twin
       │  "dinner this weekend? when, where, budget?"   │
       │ ─────────────────────────────────────────────►│  free-busy · location · food · budget · mood
       │◄───────────────────────────────────────────── │  "Sat 8pm · ≤₹1.5k pp · no seafood · near Indiranagar"
       │  3 places that fit both, from both food channels, travel times
       │ ─────────────────────────────────────────────►│
       │◄───────────────────────────────────────────── │  "Toit works"
       ▼                                                ▼
   card: "Sat 8pm Toit. Rohan's twin agreed."      card to Rohan
   [Confirm] [Change]                              [Confirm] [Change]
       ▼ both confirm
   reservation · cab 7:15 · reminder · talking points: his marathon, the advance
```

1. Twins discuss and negotiate: time, place, budget, split, plan, purchase, who brings what.
  
2. Each twin speaks only within scopes its owner allowed. Defaults by circle.
  
3. The result is one card per owner. Anything binding needs both to confirm.
  
4. After confirmation the twins keep working: booking, cab, reminders, preparation, follow-up after.
  
5. Twin messages are signed events. Both sides see the log.
  
6. Over the open protocol between SuperTwins; over email, message and call with people and assistants that have no node.
  
### 19.3 Shared spaces, groups, families, group money
1. A space can be shared with named people or a circle. What is shared by default: goal, summary, latest, plan, tasks, results, artifacts, enrichment. What is never shared: evidence from private streams, claims about people outside the space, the owner's other spaces. Evidence from a stream every member is already in (the group chat) can be shown.
  
2. People without a twin get an invite link. Accepting creates their identity and installs their twin.
  
3. Tasks have owners across users. Each twin holds its owner's tasks. Sharing is reversible; a member who leaves keeps a snapshot of what was shared until they left.
  
4. **Family setup**: one member sets up twins for parents, partner and kids. A parent who will never install an app gets a **voice twin**: a twin reached by phone call that reminds, answers, reports and is protected by verified calls.
  
5. **Group money**: the twin extracts who owes whom from the group's own chats, keeps the group ledger across the members' twins, and settles over UPI or the local rail with the payment gate. The group cannot leave while its ledger lives in the twins, and the group needs every member on it to settle.
  
6. Family location and safety, from location and proximity, shown only within the family's scopes.
  
### 19.4 Relay and cost
1. The initiating twin pays for a twin-to-twin thread by default. Both can share. The protocol carries a cost field so any arrangement works.
  
### 19.5 Interop with other assistants
1. Instinct, Town, Muse and the rest expose email, phone and messaging and will never expose APIs. The twin coordinates with them the way it coordinates with a human: by writing to them, signed. We do not wait for federation, and we join any protocol that becomes real.
  
### 19.6 Openness
1. Open now: the protocol specification, the identity format, the adapter and skill SDK, and a reference node. The twin runs OpenClaw and Hermes skills and MCP servers, and exposes its memory to other agents through an MCP server under the owner's scopes.
  
2. Ours: the apps and their polish, the directory, the relay, the numbers, the market, the premium tiers.
  
3. Why now and not after density: closed networks are forming this month. The open standard wins only if it exists before they lock in.
  
4. Downsides, accepted: forks that compete with our own client; a giant that adopts and then abandons the protocol, as Google did with XMPP; support burden; investors who want lock-in. Offsets: OpenClaw and Hermes built the largest communities in this space by being open, and a network of nodes is not copied by copying code.
  
5. We do not open-source a second full assistant to compete with OpenClaw for developers. We make the twin able to run their skills.
  
## 20. Public
### 20.1 Access levels
```
  private ─► shared with named people ─► shared with a circle ─► public ─► paid subscribers
```

1. Recommendations, try lists, taste channels, research collections, reading lists, travel logs, portfolios, learning spaces, recipe collections are the key public spaces.
  
2. Any level per space. A Goa list can be circle-only and a reading list public.
  
3. Public and shared spaces show curated content only. Never private evidence, never private people.
  
4. The twin drafts posts and updates per platform, in that platform's tone and subjects. The user approves each, or marks a space auto-post.
  
### 20.2 Follow and subscribe
1. Anyone can follow a public space. Followers get updates in their own twin.
  
2. A followed recommendation list becomes a try list in the follower's twin. A friend's Goa list seeds your Goa trip.
  
3. Follows are consent on both sides. Blocking is one tap.
  
### 20.3 Public twin and public page
1. A public twin answers on the owner's behalf within what is public. "What does Aditya recommend in Goa?" is answered from the public list, with sources.
  
2. Per public space the owner sets what the twin may do: answer only, take requests, accept bookings or orders.
  
3. Requests that need the owner become a task for the private twin.
  
4. The owner sees every public conversation. Rate limits and blocklists apply.
  
5. The **public page** is the view of one user's card, public spaces and taste channels plus "Ask my twin". It works from a bio, a card, a mail signature.
  
## 21. Collectives
### 21.1 Definition and kinds
1. A **collective** is a group of twins with a shared objective that act together, formed by need, interest or membership rather than by friendship, in any geography.
  
2. Kinds: buyer collectives negotiating volume prices, the Pinduoduo team-buy run by agents; resident collectives pooling orders and services in an apartment; bargaining collectives refusing surge or fees above a threshold at the same time; grievance collectives filing complaints to a telecom or a regulator at once; interest and fan collectives organizing events and drives; political and civic collectives coordinating action. Any group with a common objective.
  
### 21.2 Mechanics without partnerships
```
   300 twins: motor insurance renewing in Oct, Bengaluru
        │  (needs observed by each twin, aggregated with consent, anonymized)
        ▼
   collective's twin ─► RFQ by email, WhatsApp, call ─► insurer A · insurer B · insurer C …
                                                          │ offers (or silence)
        ┌─────────────────────────────────────────────────┘
        ▼
   each member's twin ─► fills the chosen policy on the insurer's site with the offer code
                     ─► owner's payment gate ─► done ─► ledger
```

1. The collective's twin runs a request for quotes by outreach: it emails, messages and calls sellers with the aggregated, verified demand and asks for the best offer. Sellers who respond win the volume; sellers who ignore it lose it. No tie-up is needed, only sellers who read email.
  
2. Members' twins execute individually on the seller's website with the offer, behind each owner's payment gate. Escrow, ratings and disputes live in the protocol.
  
3. Demand is verified because twins observed the need; it is not self-reported. That is what makes sellers respond.
  
### 21.3 Examples
1. Three hundred twins in one city renewing motor insurance this month get quotes from every insurer's channel.
  
2. An apartment's twins pool the weekly grocery order and the annual pest control contract.
  
3. A city's twins refuse cab surge above a threshold tonight and the platform's pricing sees it.
  
4. A class's parents' twins negotiate the school's fee hike with one voice.
  
5. Fans' twins organize a screening and a meet-up in ten cities on one weekend.
  
## 22. Twin economy and business model
### 22.1 Who pays, when
1. Day one: we pay for understanding for everyone, because on DeepSeek-class models it costs under a few dollars a month per user. Execution is metered: a free allowance, paid tiers above it, and bring-your-own keys, OpenRouter keys or CLI subscriptions unmetered. Prosumers with their own subscriptions cost us nothing.
  
2. At scale: the task market, creator taste subscriptions, numbers, relay and home boxes. Brand spend to reach twins is acquisition and retention budget and arrives only with scale; it is not counted on for day one.
  
### 22.2 Tiers
1. Free: full observer and memory, full network, metered execution allowance, standard voice.
  
2. Paid tiers: more execution, cloned voice, the twin number and email, own-cloud 24x7 image, priority in the market. Priced under Muse in every market.
  
3. Bring your own: any tested model key or CLI subscription, unmetered.
  
### 22.3 The task market
```
  brand twins ──► user twin's inbox (no screen, unlimited) ──► filter by needs, claims, spaces
                                                                    │
                                                                    ▼
                                                            shortlist (0–3) ──► one card, when relevant
  payment:  per contact (small) · per shortlist (larger) · per acted-on (largest)
            ≥ 90% to the user · rest to the platform · user sets who may contact and floors
```

1. The **task market** is the place where a user's task, with the user's consent and within a scope the user set, is broadcast to business twins that may respond with offers, availability, quotes or fulfilment. Business twins pay to respond. Most of the payment goes to the user; a small fee stays with the platform. That fee is the business.
  
2. The value proposition to the user: your tasks earn you money. The twin that was going to compare insurers anyway gets paid by the insurers that want to be compared.
  
3. The user controls whether business twins may contact at all, in which categories, at what minimum price, and how often. A business twin sees the task, never the person's data.
  
4. A user's twin can also post a task other twins can do, and pay for it, and can do tasks for other twins and get paid: a local expert's recommendation list, a translation, a review.
  
### 22.4 Creator taste subscriptions
1. A creator's channels can be paid. Subscribers' twins pay the creator's twin. A fee stays with the platform.
  
### 22.5 Services
1. Numbers and email addresses for twins, own-cloud images, relay capacity beyond the free allowance, and a home box: a small device that runs the twin 24x7 at home, holds all data, runs local models and hosts the public twin. Hardware is a margin business no lab runs and a switching cost no cloud agent has.
  
### 22.6 Business twins
1. A **business twin** is a twin for a shop, clinic, school, restaurant, vendor or brand. It answers customers' twins and customers, takes bookings and orders within its owner's settings, responds to collectives' requests for quotes, and pays to respond in the task market. Businesses get it free. Each business twin brings its customers' twins into the network.
  
### 22.7 What we never do
1. No ads on any surface. No sale of user data. No feed. No cloud copy of raw data on our servers. No autonomous payments or private sends.
  
## 23. Apps and devices
```
                    ┌──────────────────────────┐
                    │  HOME BOX  or  OWN CLOUD  │  24x7 brain · store · public twin host · relay
                    └─────┬──────────┬───────┬─┘
                          │ signed, encrypted sync
              ┌───────────┘          │       └───────────┐
              ▼                      ▼                   ▼
        ┌──────────┐          ┌──────────┐         ┌──────────┐
        │   MAC    │          │  PHONE   │◄────────│ WATCH ·  │
        │ overlay  │          │ capture  │         │ EARBUDS ·│
        │ menu bar │          │ approve  │         │ PORTABLE │
        │ hands    │          │ calls    │         └──────────┘
        └──────────┘          └──────────┘
              ▲                      ▲
              └── WhatsApp self-chat · iMessage · Mail · twin number & email ──┘
```
### 23.1 Desktop overlay and menu bar
1. Mac app, always resident. Menu bar icon shows capture and attention state.
  
2. The main window is a full-screen overlay. Summon hotkey brings it up with a fade and blur. Esc dismisses. Windowed mode is a setting.
  
3. Design: translucent glass over a live background. The background is a slow animated scene that reflects the time of day, the weather now, and the user's city. The user can pin a scene or turn it off.
  
4. Tabs: Home, Spaces, Tasks, Calendar, People, Taste, Me, Timeline, Library, Scratchpad, Browser, Public, Settings.
  
5. Nudges show inside the overlay and outside it, same card. The grounded bar floats inside the overlay and over the desktop.
  
### 23.2 iPhone app
1. Capture: ambient audio, keyboard, share sheet, screenshots, location, calendar, contacts, health, calls through the twin number.
  
2. Surface: Today, Needs you, Chat, Spaces, Taste, People, Me, Scratchpad. Approvals on the phone approve tasks running anywhere.
  
3. Live activity shows running tasks and the ambient audio state with a one-tap off.
  
4. Action button and Shortcuts summon the twin. Siri App Intents expose the twin's actions.
  
5. Local store with sync to the Mac, home box or own cloud. Light tasks run on the phone; heavy execution runs where the browser is.
  
### 23.3 Android app
1. Everything the iPhone app does, plus the notification listener, native call screening, SMS, and optional accessibility. Views for Calls and Notifications.
  
### 23.4 WhatsApp, iMessage, Mail, twin addresses
1. **Self-chat.** The user messages their own WhatsApp "You" chat, their own iMessage, or their own mail address. The twin, already paired to the user's account, reads and replies there. No new number, no setup.
  
2. **Twin number and twin email.** The twin's own addresses, given to the world.
  
3. Send a forward, a voice note, a photo, a question, or an order. It replies in the same channel with text, reactions, stickers or a link to a card.
  
4. Approvals can be answered by reply for non-gated confirmations. Gated steps still need the app's tap.
  
5. WhatsApp is one channel of several. The product does not depend on it surviving.
  
### 23.5 Home box and bring-your-own cloud
1. **Home box.** A box at home runs the twin 24x7, holds all data, runs local models, hosts the public twin, acts as the relay for its owner. Phone, Mac and device sync to it. The Mac can sleep.
  
2. **Bring-your-own cloud.** One-click setup on the user's own account at a cloud provider: a container image plus a setup script. The user owns the server and the data. We never host and never store user data.
  
3. **Hands stay at home.** Datacenter IPs get blocked by WhatsApp, Instagram, X and others. Capture and browser actions for those services run on the Mac or home box. The cloud runs the brain and the store.
  
4. Optional. Solo mode works with the Mac alone, or the phone alone with a smaller brain.
  
### 23.6 Watch, earbuds, portable device
1. Apple Watch and AirPods as ears and as a whisper channel on calls.
  
2. Later, a small always-with-you device: mic, camera, button. Same memory, same twin.
  
### 23.7 Sync
1. Devices exchange signed, encrypted event batches. Any device can be offline. Order is by event id.
  
2. Conflicts are rare because everything is append-only. Derived state is rebuilt from events.
  

* * *
# Part C — System
## 24. UI, UX and screens
Design language: glass over the live scene. One type scale. One card anatomy: header, body, evidence strip, three-item menu (Edit, Remove, Tell the twin). Every card is interactive: sort, filter, edit, approve, ask a follow-up. Results are typed: comparison table, itinerary, draft, approval card, question card, brief, checklist, receipt, map, calendar slot, form preview, chart, gallery, transcript, thread, call summary, taste list, recap. The model picks composition and content; the design system owns color, type and layout. Any card or answer can embed a live page from the SuperTwin browser.
### 24.1 Onboarding
```
 ┌────────────────────────────────────────────────────────────────────┐
 │  Connect a source                                    step 2 of 3   │
 │                                                                    │
 │  ┌ WhatsApp ─────┐ ┌ Browser ──────┐ ┌ Screen ───────┐ ┌ Ears ───┐ │
 │  │ chats, media  │ │ history, tabs │ │ what you see  │ │ what you│ │
 │  │ never: status │ │ never: incog. │ │ never: passw. │ │ hear    │ │
 │  │ [ Pair ]      │ │ [ Connect ]   │ │ [ Allow ]     │ │ [Allow] │ │
 │  └───────────────┘ └───────────────┘ └───────────────┘ └─────────┘ │
 │  more sources later from Library                                   │
 │                                                                    │
 │  ── WhatsApp paired ✓ · counted 38,412 messages in 214 chats ───── │
 │  Index      [ everything ▾ ]   38,412 messages · 210 MB   exact    │
 │  Understand [ 30 days ▾ ]       1,204 messages · ~3¢ · ~4 min      │
 │  Nothing goes to a model until you confirm.                        │
 │                            [ Skip for now ]   [ Confirm & start ]  │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.2 Home (overlay)
```
 ┌── ⌂ Home ▤ Spaces ☑ Tasks ▦ Calendar ◙ People ♥ Taste ◍ Me ◷ Timeline ▥ Library ✎ ⚙ ──┐
 │                                                     ▓ live scene: evening, drizzle, Bengaluru ▓ │
 │ ┌─ Needs you ───────────────────────┐  ┌─ Spaces ────────────────────────────────────────────┐  │
 │ │ ▸ Pay insurance renewal ₹8,400     │  │ ● Goa trip with Rohan · Dec   villa shortlisted · 3  │  │
 │ │ ▸ Confirm: dinner Sat 8pm Toit     │  │ ● Ma's birthday · 14 days     gifts · dinner · cake  │  │
 │ │ ▸ Q: Ma's ticket — AC or sleeper?  │  │ ● v13 launch                  4 tasks · Sameer       │  │
 │ │ ▸ Join: Tanvi shared "Diwali gifts"│  │ ○ Gym restart (dormant)                              │  │
 │ └───────────────────────────────────┘  └──────────────────────────────────────────────────────┘  │
 │ ┌─ Prepared for you ────────────────┐  ┌─ Today ──────────────┐ ┌─ Recent understanding ─────┐  │
 │ │ ◆● Villa comparison — 3 fit budget │  │ 20:00 dinner · Toit  │ │ + Rohan prefers aisle seats│  │
 │ │ ◇  Reply to Ma (Hindi)             │  │ 19:15 cab booked ◆   │ │ + Trip budget ₹6k/night   │  │
 │ │ ◇  Clinic moved to Thu 11am        │  │ 3 calls handled ☎   │ │ + heard: Hampi in October │  │
 │ └───────────────────────────────────┘  └──────────────────────┘ └────────────────────────────┘  │
 │                 ┌───────────────────────────────────────────────────────┐                        │
 │                 │ ⌕  Ask, search, or tell me to do something          ↑ │  🎙 ears on · ⏸        │
 │                 └───────────────────────────────────────────────────────┘                        │
 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
```
### 24.3 Space view
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
 │ taste     ♥ 4 Anjuna places · Tanvi's food channel · 2 yours       │
 │ enrich    fares ₹4.8–5.6k · villa availability · 29°C · Sunburn wknd│
 │ evidence  ▂▃▅▂▃  WhatsApp · browser · screen · mail · heard        │
 │                                          why? · trace · ··· share  │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.4 Tasks
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
 │ RUNNING (2)  book villa · step 3/5 · trace ▸   compare TVs · done ✓ │
 │ DONE TODAY (4)                                                   ▸ │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.5 Calendar
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
### 24.6 Person card
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ ◙ Rohan Mehta                  ⦿ close friends · twin: @rohan ✓ L2  │
 │ claims    prefers aisle · not vegetarian · runs Sundays · hates hold│
 │ tone      Hinglish, short, 🔥-heavy · "bhai" · "scene?" · DM only  │
 │ shared    ● Goa trip · ● Diwali gifts       shared memory: tab ₹5k │
 │ scopes    he gives: free-busy · food · location(city) │ you give: … │
 │ taste     you follow: food (Bengaluru) · he follows: AI reading    │
 │ loops     Karan's villa advance (Goa) · birthday in 12 days (7d)   │
 │ follow-up reply owed since Tue · start acting Fri                  │
 │ recent    WhatsApp 2h ago · dinner Sat (heard: Hampi) · split PDF  │
 │ theirs    marathon in Jan (public space) · Goa list (following)    │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.7 Menu bar and nudge
```
 ┌─ SuperTwin ──────────── ③ ● rec 🎙 ⏸ ▾ ─┐   ┌─ nudge (top-right, and in-app) ───┐
 │ NEEDS YOU                                 │   │ ◆ Goa trip › Stay                 │
 │ ▸ Pay renewal ₹8,400        [view] [✓]    │   │ Saw you comparing Anjuna villas.  │
 │ ▸ Ma's ticket?           [AC] [sleeper]   │   │ Compared 6 across 3 sites.        │
 │ PREPARED                                  │   │ 3 fit ₹6k/night.                  │
 │ ◆● Villa comparison           2:41pm      │   │ ┌───────────────────────────────┐ │
 │ ◇ Reply to Ma                 9:20am      │   │ │ Villa Sol ₹5.4k ★4.8 · pool   │ │
 │ TODAY  dinner 8pm · cab 7:15 · pool 6pm   │   │ │ + 2 more · ♥ Tanvi ate nearby │ │
 │ ☎ 3 calls handled · 1 message for you     │   │ └───────────────────────────────┘ │
 │ ────────────────────────────────────────  │   │  [ Open ]  [ Not now ]  ✕   ◷ 47s │
 │ ⌕ ask…   private moment   forget 10 min   │   └───────────────────────────────────┘
 └───────────────────────────────────────────┘
   ③ = cards shown but not opened. Nothing is lost by closing one.
   ◷ = auto-close countdown, 60 s.
```
### 24.8 Grounded bar
```
 ① collapsed   ┌ ⌕ Ask, search, or tell me to do something ↑ ┐
 ② typing      ┌ ⌕ goa vill▌                                 ┐
               │  ▸ 12 events · ▸ 2 episodes · ▸ Goa › Stay   │
 ③ answer      │ you: how much per night?                     │
               │ twin: ₹6k max — you, Aug 24 ¹ · Rohan ²      │
               │ ¹ ❝max 6k a night yaar❞  ² ❝under 20k pp❞    │
               │ coverage: WhatsApp since Jan 2024 · mail ✓   │
 ③' general    │ you: what's the GST on hotel rooms?          │
               │ twin: 12% under ₹7.5k… (not from your data)  │
 ④ acting      │ you: remind rohan about the advance          │
               │ twin: ❝bhai villa advance ₹5k…❞  ✎           │
               │ [ Send (approve) ] [ Change ] [ Cancel ]     │
 ④' creating   │ you: plan hampi trek in october, tanvi's     │
               │      coming, budget 15k, she's vegetarian    │
               │ twin: creating space → swept 4 related ✓     │
 ⑤ locked      │ ⊙ task: Book villa  ✕                        │
               │ you: this is karan's, not mine → moved ✓ undo│
 ⑥ history     │ ▸ villa advance · ▸ hampi trek · ▸ per night │
```
### 24.9 Taste
```
 ┌─ Taste ────────────────────────────────────────────────────────────┐
 │ MY CHANNELS                              draws  adoptions  firsts  │
 │ ♥ Food · Bengaluru        public          142      38        4     │
 │ ♥ AI reading              circle           27      61        9     │
 │ ♥ Films                   named: Tanvi      1       3        —     │
 │ ♥ Running gear            private           —       —        —     │
 │   [ + new channel from what I consume ]   hidden items never leave │
 │ ─────────────────────────────────────────────────────────────────  │
 │ I FOLLOW                                                            │
 │ Tanvi · food (Goa, Bengaluru) · match 78%      Rohan · AI reading  │
 │ @foodwalker (creator) · food · ₹99/mo          [ + follow a twin ] │
 │ ─────────────────────────────────────────────────────────────────  │
 │ FROM PEOPLE YOU FOLLOW (in context only)                            │
 │ Goa › Food: 4 places from Tanvi · 2 from @foodwalker · you: 2      │
 │ ─────────────────────────────────────────────────────────────────  │
 │ RECAP  September, by your twin · [ preview ] [ share as video ]    │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.10 Me: card, face, address, ledger
```
 ┌─ Me ───────────────────────────────────────────────────────────────┐
 │  ┌──────┐  Aditya's twin · @aditya ✓ verified L2 · twin since Sep 26│
 │  │ face │  can: answer from public · take requests · no bookings    │
 │  └──────┘  reach the human: WhatsApp (circle) · twin: +91 …  · a@… │
 │  public: Goa recs · reading list · Food Bengaluru ♥  reliability ●●●●○│
 │ ─────────────────────────────────────────────────────────────────  │
 │ MASTER ADDRESS   +91 own (private) · +91 twin (public) · a@ own (circle)
 │                  twin@ (public) · x.com/aditya · linkedin/aditya · page │
 │ FACE & VOICE     [ remake face ] [ sticker pack ✓ ] voice: standard ▾ │
 │ LIFE STORY       11 chapters · 214 lines · 9 to confirm  [ open ]    │
 │ LEDGER (Sep)     312 things handled · 14h 20m · ₹23,400 saved ·      │
 │                  ₹1,180 earned · 41 calls · 3 approvals  [ open ]     │
 │ TENURE           38 days · 61 h of audio · 12,400 screen events      │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.11 Ledger and trace
```
 ┌─ Ledger ── Sep 12 ─────────────────────────────────────────────────┐
 │ 17:45  call   moved dad's appointment to Thu 11am      authority: task #412, not gated
 │               transcript ▸ · 3 model calls · $0.04 · trace ▸       │
 │ 16:31  send   WhatsApp to Rohan: "bhai villa advance…"  authority: approval 8f2c (you, 16:30)
 │ 14:02  made   villa comparison, 6 across 3 sites        authority: live, executor-lite
 │               inputs: 3 Airbnb visits, budget claim ¹, dates ²  · $0.02 │
 │ 12:15  told   "Kindle out for delivery 6pm"             from: Amazon mail
 │ 08:10  filled insurance renewal up to payment           waiting: approval
 │ 07:20  gate   2 calls: courier (rescheduled), bank (declined, spam)   │
 │ filters: actions · money · calls · approvals · inferred vs told      │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.12 Scratchpad and Browser tabs
```
 ┌─ Scratchpad ─────────────────────────────┐  ┌─ Browser ────────────────────────────┐
 │ 15:30 📷 restaurant shot → Goa › Food ✓   │  │ logged in: airbnb ✓ amazon ✓ x ✓ ig ✓ │
 │ 14:10 📋 "villa sol anjuna" → Goa › Stay  │  │ agent tabs (2)  Book villa · step 3   │
 │ 11:02 🎤 "call the clinic, move to thu"   │  │   ▸ replay · ▸ take over · ▸ stop     │
 │        → task ✓ done 17:45                │  │ sessions today 6 · skills 14          │
 │ 09:40 ⬚ Mouse Helper: fare table → saved  │  │ [ open a tab ]  [ connect a login ]   │
 └───────────────────────────────────────────┘  └──────────────────────────────────────┘
```
### 24.13 Phone
```
 ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
 │ Today            │  │ Approve          │  │ 🎤 hold to talk  │  │ Calls            │
 │ ● Pay ₹8,400     │  │ Pay ₹8,400       │  │ "add milk to the │  │ 07:12 courier ✓  │
 │ ● Ma's ticket?   │  │ HDFC Ergo · 1 yr │  │  grocery space"  │  │  rescheduled 6pm │
 │ ○ Dinner 8pm ◆cab│  │ card •• 4412     │  │                  │  │ 07:40 bank ✕ spam│
 │ ◆ Villa compare  │  │ criteria 5/5 ✓   │  │ ✓ added · 👍     │  │ 09:02 Ma ─► you  │
 │ ☎ 3 handled      │  │ signed by you ✓  │  │ live: 🎙 on · ⏸  │  │ [ instructions ] │
 │ ⌕ 📷 🎤 📎 ♥ ◙ ◍  │  │ [ Approve ]      │  │ ⌕ 📷 🎤 📎 ♥ ◙ ◍  │  │ ⌕ 📷 🎤 📎 ♥ ◙ ◍  │
 └──────────────────┘  └──────────────────┘  └──────────────────┘  └──────────────────┘
```
### 24.14 WhatsApp self-chat and twin email
```
  You (to yourself):  [forwarded] "Anjuna villa ₹5.4k, pool, 6 beds"
  Twin:               👍 added to Goa trip › Stay. Cheapest of your 3. Tanvi ate nearby ♥
  You:                book it
  Twin:               Ready. ₹16,200 for 3 nights, free cancel till Dec 1.
                      Tap to approve → supertwin://approve/8f2c

  From: school@…  To: twin@aditya…   "PTM on Sep 20, please confirm"
  Twin ─► calendar (tentative) · task "confirm PTM" · reply within gate: "Confirmed for Aditya" ✓ signed
```
### 24.15 Public page and card
```
 ┌────────────────────────────────────────────────────────────────────┐
 │ ┌────┐ @aditya · verified ✓ · twin since 2026        Follow · Ask   │
 │ │face│ Goa recommendations · Reading list · ♥ Food Bengaluru (142)  │
 │ └────┘ can: answer · take requests                                  │
 │ ▸ Gunpowder, Assagao — "best pork vindaloo, go early"              │
 │ ▸ Villa Sol, Anjuna — "pool, 6 beds, ₹5.4k in Dec"                 │
 │ ▸ Morjim beach at sunrise                                          │
 │ ──────────────────────────────────────────────────────────────────  │
 │ Ask Aditya's twin:  ⌕ "good for a family of 5?"                     │
 └────────────────────────────────────────────────────────────────────┘
```
### 24.16 Collective
```
 ┌─ Collective · Motor insurance, Bengaluru, October ─────────────────┐
 │ members 312 twins · your need: Honda City, renew by Oct 14         │
 │ quotes   ICICI ₹8,100 · HDFC Ergo ₹8,400 · Acko ₹7,650 (best)      │
 │ status   RFQ sent to 9 insurers · 3 replied · closes Oct 5         │
 │ you      [ take Acko offer → your twin fills, you pay ]  [ leave ] │
 │ share    forward to a group → members join with one tap            │
 └────────────────────────────────────────────────────────────────────┘
```
## 25. Architecture
```
 ┌──────────────────────────────────────────────────────────────────────┐
 │ SURFACES    overlay · menu bar · iPhone · Android · chat channels ·  │
 │             calls · twin number & email · public pages               │
 ├──────────────────────────────────────────────────────────────────────┤
 │ SERVICES    grounded bar · surface router · space loop · executor ·  │
 │             scheduler · call agent · inbound gate · taste curator ·  │
 │             twin protocol client · collective runner · market client │
 │             · sync · MCP server (memory out) · skill runner          │
 ├──────────────────────────────────────────────────────────────────────┤
 │ UNDERSTAND  packer · live call · orient · critic · extract · decide ·│
 │             digest · consolidation · life story writer               │
 ├──────────────────────────────────────────────────────────────────────┤
 │ MEMORY      event log · FTS · embeddings · graph (entities · edges · │
 │             bridges) · world model · calendar · taste · ledger ·     │
 │             coverage index · traces · public store (separate)        │
 ├──────────────────────────────────────────────────────────────────────┤
 │ CAPTURE     adapters · filter · consent gate · SuperTwin browser ·   │
 │             computer hand · phone capture · audio pipeline           │
 ├──────────────────────────────────────────────────────────────────────┤
 │ BRAIN       doors (CLI · OAuth · key · metered) · per-step models ·  │
 │             local models · skills                                    │
 ├──────────────────────────────────────────────────────────────────────┤
 │ TRUST       consent records · approval tokens · SuperTwin ID keypair │
 │             · signatures · scopes · audit log                        │
 └──────────────────────────────────────────────────────────────────────┘
                                   │
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                      ▼
   OUR SERVICES (thin)      OTHER NODES              THE WORLD
   directory · relay ·      twins over the           email · phone · WhatsApp ·
   numbers · market ·       protocol                 websites · apps · other
   tier metering · builds                            assistants · businesses
```

1. **One worker process** per node owns the log, the lanes and the services. The UI renders and emits events. On the phone a lighter worker runs capture, chat, approvals and light tasks and syncs to the main node.
  
2. **Adapters are plugins.** One contract: enumerate, count, backfill, live, filter, act. A new source is one adapter. The adapter SDK is public.
  
3. **Passes are single-shot.** Prompt in, JSON out. Agents run only where work is being done or where a scheduled step has come due.
  
4. **Every model call has a trace.** Every action has a ledger line naming its authority.
  
5. **Sync and twin traffic are message-based.** Signed, encrypted batches. No central store of user data.
  
6. **The public store is separate.** The public twin can only read it.
  
7. **Our services are thin by design.** Directory, relay, numbers, market and metering hold no user content; the relay holds ciphertext.
  
8. **Skills run in a sandbox** with declared tool access. Open ecosystem skills get no more than they declare.
  
## 26. System design
### 26.1 Event envelope
```
 event {
   id · ts · captured_at · source · kind · origin live|backfill|archive|twin
   stream_key · actor · roles { sender, audience[], receiver[], mentions[] }
   payload (typed) · content_hash · blob_refs[] · consent_id · tier
   signature? (for events from other twins) · device_id
 }
```
### 26.2 Lanes
```
  LIVE       state gate: HOT flushes now · BURST flushes now · COLD idle 300 s / max 540 s /
             20k chars · never empty
             → one call: orient + decide → executor · critic parallel, may retract
             reserved slots: history can never queue a nudge
  HISTORY    one calendar day per call per source, split at 30k chars, newest first, empty days skipped
             →  orient → critic → extract → decide
             never nudges · never starts executors except scheduled recurrences
  DIGEST     tier-3 streams, one week per call, only weeks with new events
             →  summary · claims · recurrences
  TWIN       messages from other twins: verified, scoped, then treated as a hot live event
  TASTE      consumption events → taste memory → channel curation on change
```
### 26.3 Passes
| Pass | Unit | Output |
| --- | --- | --- |
| Live | one live bundle | episodes, filing, tasks, schedules, closures, questions, prepared actions |
| Orient | one history bundle | episodes, filing, proposals, unsorted, questions |
| Critic | any write set | commit, reject, downgrade, flag |
| Extract | committed episodes | claims, people, tone, feelings, taste |
| Decide | one space | summary, latest, plan, milestones, tasks, schedules, closures, follow-ups |
| Digest | one tier-3 stream, one week | summary, claims, recurrences |
| Life story | changed chapters | chapter lines with evidence and provenance |
| Route | one bar query | question class + retrieval plan |
| Judge | fused top-10 candidates, T1 and T2 only | 3–5 results with quotes |
| Surface router | one artifact | surface, timing |
| Gate | one inbound contact | pass, screen, answer within scope, decline, escalate |
| Negotiate | one twin-to-twin thread | proposals within scopes, one card per owner |
| Curate | one taste channel, on change | keep, hide suggestions, domain, summary line |
### 26.4 Retrieval
Five methods run against one index. Similarity answers one kind of question.

| Method | Answers | Fails at |
| --- | --- | --- |
| Lexical (BM25) | rare tokens, names, numbers | paraphrase |
| Vector (EmbeddingGemma 300M, local, 768-d) | "the villa with a pool" when the page said "6 beds, swimming pool" | counting, absence |
| Structured (SQL over the world model) | sums, counts, date ranges, status filters | anything not typed |
| Graph | "what does Ma care about", "who did we meet through Rohan" | starting cold |
| Time window | "what happened Tuesday afternoon" | relevance |

1. No top-k of chunks is a sum, and no ranking proves an absence. Questions shaped how much, how many, did anyone ever, list all route to structured or to a bounded scan.
  
2. Fusion is by reciprocal rank, not a score union.
  
3. A local cross-encoder reranker runs on the fused candidates at every tier. A judge call runs at T1 and T2 only.
  

```
 T0  HYBRID        lexical ∪ vector ∪ exact keys → RRF → cross-encoder
     ~150 ms · 0 model calls · local
     ▸ the packer (every bundle) · bar type-ahead · consolidation · taste in context
                   │ evidence insufficient?
                   ▼
 T1  PLANNED       one fast call → retrieval plan → code executes → fuse → judge
     ~1 s · 1 call
     ▸ most bar questions · executor context · public twin
                   │ still insufficient?
                   ▼
 T2  AGENTIC       loop: search → read → name what is missing → search again
     5–30 s · 3–8    budget: hops · seconds · money → best-partial + gaps
     ▸ multi-hop · absence proofs · "everything about X" · contradictions
```

4. The packer never leaves T0. The bar and the executor escalate freely.
  
5. **The index:** event chunks, episode summaries, space cards, claims, people cards, how-tos, artifacts, taste items, ledger lines. Typed fields ride alongside the text. The **coverage index** records per source, per date range, what exists and what was never captured, which is what makes "three so far, and I only have WhatsApp back to Jan 2024" truthful.
  
6. Retrieval never writes. Every tier reads and cites by id.
  
### 26.5 Graph
The entity graph is entities, edges, edge evidence and bridges, in the same SQLite database as everything else. Edges are typed and weighted, carry a validity window, and cite the event that made them.

```
  seeds (from lexical + vector)        hop 1                  hop 2
   ◉ Ma ──── mother_of ─────────────► ◉ self   ✗ hub, excluded
     └────── mentioned_in ──────────► ◉ ep_882 ─ about ─────► ◉ Diwali gifts
     └────── prefers ───────────────► ◉ jasmine tea
   ◉ Rohan ─ close_friend ──────────► ◉ Tanvi  ─ in ────────► ◉ Goa trip
   ◉ Tanvi ─ channel(food) ─────────► ◉ Gunpowder ─ adopted_by ─► ◉ self (Sep 3)

   score = hop decay × edge confidence × evidence recency
   superseded and expired edges skipped · fan-out capped per node
```

1. Bridges (URL, phone, order id, mail thread, call id, twin thread id) are the highest-precision edges: exact matches, no model.
  
2. Seeds come from lexical and vector; two to three hops; hub nodes such as the user excluded.
  
3. One store. A second datastore would split the critic-gated commit and break the hybrid queries.
  
### 26.6 Scheduler
1. Holds wake-ups: scheduled steps, scheduled tasks, recurrences, lead-time planning, polls with stop conditions, follow-up checks, closure checks, collective deadlines, twin-thread timeouts.
  
2. Fires into the executor with the space context. Missed wake-ups fire on wake, with the delay shown.
  
3. Every wake-up is visible on the calendar in the twin layer and in the ledger as scheduled.
  
4. A wake-up is a lookup before it is a call. Nothing changed, no model call, and the wake-up is logged as a no-op.
  
### 26.7 Twin protocol
```
 message {
   from_key · to_key · thread · intent · scopes[] · body · cost · ts · sig
 }
 intents: propose · counter · accept · decline · ask · share(scope) · invite · rfq · offer · settle
```

1. Each twin answers within granted scopes. Anything else returns "ask my owner" and becomes a task.
  
2. Transport: any relay holding ciphertext, or direct when both are online.
  
3. Bridged transport: the same intents rendered as plain email, message or a call script for people and assistants without a node, signed with a verification code.
  
4. The specification is public; conformance tests ship with the reference node.
  
### 26.8 Directory and relay
1. The directory maps handle → public key, master address entries with their scopes, verification level, and the relays the node uses. Lookups are rate-limited and logged to the owner.
  
2. The relay stores ciphertext for a bounded time and forwards on connect. Any relay may be used; the home box is one.
  
### 26.9 Safety invariants
1. No adapter reads before its consent record exists.
  
2. Gated actions require a single-use token signed by the owner's SuperTwin ID, bound to recipient, amount and payload.
  
3. Spend and call ceilings throw before the model is called.
  
4. A bundle is attempted at most 3 times, then dead-lettered and shown.
  
5. Deleting a source cascades to everything derived from it, including taste items and ledger references.
  
6. History output never reaches a nudge surface.
  
7. The public twin reads only the public store. Other twins read only within scopes.
  
8. Browser and computer hands stop on any challenge page and never automate login.
  
9. A model call is never gated on a content heuristic. The state gate reads the world model, never the text.
  
10. The packer never enumerates. Candidate spaces come from retrieval, capped at 5.
  
11. Captured content is never an instruction. Instructions live only in the system prompt. A tool call whose argument came from captured text is validated against the world model before it runs. Messages from other twins are captured content.
  
12. No write without evidence. Fabrication is an automatic reject.
  
13. Every loop is metered: executor cycles, replays, browser sessions, polls, agentic retrieval, twin threads, collective RFQs.
  
14. Retrieval never writes.
  
15. The packer never escalates past T0.
  
16. No new event, no model call.
  
17. An explicit user instruction is stored as a self-reported claim with its source and is never replaced by an inference.
  
18. Run state, task state and wake state are separate records.
  
19. Anything hidden by the owner never leaves the device, in any channel, scope or artifact.
  
20. Voice cloning requires explicit consent and every cloned call declares itself.
  
## 27. Step by step
### 27.1 A live moment
Rohan writes "guys lets lock goa 18-21 dec" in the Goa gang group. The user then opens Airbnb.

```
  1  CAPTURE    WhatsApp adapter emits e1. Consent ok. Filter ok. Tier 1. Written to log.
  2  ARCHIVE    FTS indexed. Chunk embedded. Stream wa:goa-gang.
  3  GATE       e1's stream has an open task ("collect advance from Karan") → HOT → flush now.
                Bundle = e1 + what accumulated since the last flush: 3 Airbnb visits, 1 Airbnb screen.
  4  PACK       Thread history (40 msgs), open episodes, candidate spaces (retrieval),
                open tasks, calendar, roster, bridges (airbnb URLs), taste in context, time.
  5  LIVE CALL  Episode "dates locked 18–21 Dec" → space Goa trip. Task "book flights",
                schedule check-in T-48h, plan updated. Intent: comparing villas, 0.9.
                Prepared action: compare villas. Critic in parallel: commit.
  6  EXTRACT    Claims: dates 18–21 Dec. Rohan will share flight link. Feeling: excitement.
  7  EXECUTE    Executor-lite compares 6 villas across 3 sites with budget and dates,
                adds 4 Anjuna places from Tanvi's food channel. Artifact.
  8  ROUTE      Mac active → nudge card + panel + space banner + Home shelf. Ledger line.
  9  SPACE LOOP Summary and latest updated. Follow-up: collect advance from Karan, Sep 1.
 10  TASK       "Book flights": plan, compare, fill up to payment. Approval card.
 11  GATE       User taps. Signed token minted. Payment page in webview. User confirms.
 12  FOLLOW-UP  "Flights booked ✓" → web check-in scheduled Dec 16 07:00 · cab task Dec 18.
 13  CALENDAR   Trip, flights, check-in, cab appear in layers.
 14  TOGETHER   Shared with Rohan, Tanvi, Karan. Karan has no twin: invite by link and by
                the twin's own message. Karan's twin, once made, holds "pay advance".
 15  LEARN      User renames the cab task. Correction event. Eval case drafted.
 16  MEMORY     Trip closes in December. Preferences, people, patterns, taste, narrative updated.
                Tanvi's twin records an adoption when the user eats at Gunpowder.
```

Steps 1–8 finish within about 2 minutes of Rohan's message.
### 27.2 Backfill on first connect
```
  1  CONSENT    WhatsApp paired. Windows chosen: index everything, understand 30 days. Card confirmed.
  2  COUNT      Adapter counts per window from the source. Exact numbers shown.
  3  ARCHIVE    All history written to the log, indexed, embedded. Coverage index updated.
  4  HISTORY    Newest day first, tier 1 streams first. One call per day per source, split at 30k chars.
                orient → critic → extract → decide. Proposals go to the review queue.
  5  LIFE STORY Chapters fill as claims land: Places, People, Work, Arcs. First chapter shown.
  6  SURFACES   Proposed spaces under Needs you. Nothing nudges. No executor runs.
  7  RECURRENCE Last year's renewals become next month's tasks, marked as history-derived.
  8  DONE       Coverage shows "understood: Aug 15 – Sep 15 · indexed: all". Widening replays stored events.
```
### 27.3 An inbound call
```
  1  RING       Unknown number calls the twin number (or an unanswered call forwards there).
  2  RESOLVE    Directory, contacts, business registry, past calls → "courier, DTDC, 3 past deliveries".
  3  GATE       Circle: services. Policy: answer with delivery instructions, never share the flat's gate code
                unless a delivery is expected. Expected: Amazon order e-mail says 6pm today.
  4  ANSWER     Twin answers, declares itself, gives instructions, learns the courier is early.
  5  DECIDE     User at desk → whisper card: "Courier here now, not 6pm. Accept? [yes] [ask 6pm]".
  6  RESULT     Transcript is an event. Ledger line with authority: inbound gate rule "services".
```
### 27.4 A collective
```
  1  NEED       47 twins in one city hold a motor insurance renewal claim due next month (observed from
                policy mails and SMS). Each owner opted in to buyer collectives.
  2  FORM       The collective runner opens a collective, anonymized: count, city, month, vehicle classes.
  3  RFQ        The collective's twin sends the request by email and WhatsApp to insurers' channels and
                calls two that have no inbox. Deadline set.
  4  OFFERS     Three insurers reply with offer codes. Offers are events in every member's twin.
  5  CHOOSE     Each member's twin compares against the member's own claims (IDV, add-ons, history) and
                proposes one. Owner taps.
  6  EXECUTE    Each twin fills the policy on the insurer's site with the code, up to payment. Owner pays.
  7  LEARN      Insurer reliability recorded. Next month's collective forms with 300 twins.
```
## 28. Settings
| Group | Settings |
| --- | --- |
| General | launch at login, notifications, summon hotkey, bar hotkey, ears-off hotkey, appearance, overlay or windowed, live scene, brief times, space creation (propose, auto) |
| Capture & Privacy | per-source capture toggles, app and domain blocklists, chat and sender lists, folders, people, incognito policy, pause states, private moment, forget last N, ambient audio on/off per device, audio retention (off), screenshot capture, system audio, keyboard capture, notification capture (Android) |
| Sources | connect flows, status, index window, understand window, watermark, last event, pins, per-source pause, disconnect, delete |
| Brain | doors (CLI, OAuth, key, metered), connected account, fallback order, spend ceilings, stop-all switch, zero-retention provider pins |
| Intelligence | model per step, reasoning per step, on/off per step, recommended model, embedding model, reranker, on-device gate model, cost per step last 7 days |
| Retrieval | agentic retrieval in the bar, hop and time budgets for T2, exhaustive-scan row limit, graph hop limit and fan-out cap, hub-node list |
| Enrichment | whisper model, speaker separation, voice notes, media description, frame sampling, media in business chats, fetch linked pages, backfill rate, concurrency |
| Assist | freshness = the cold window (Live 120/180 s · Balanced 300/540 s · Relaxed 420/600 s), burst threshold, nudge card duration, merge window, intent-confidence floor, popups, surface routing rules, blocked kinds, behavioral rules list |
| Calendar | connected calendars, write-back, lead times per circle, plan or wish per circle, snooze defaults |
| Identity | handle, SuperTwin ID export, verification level, master address entries and their visibility, face, voice (standard, cloned with consent), card fields, twin number, twin email, inbound gate rules per circle, instructions for services |
| Sharing | devices, shared spaces, circles' default scopes, per-person scopes, invites, blocklist, family setup, voice twins, group money rails |
| Taste | channels and scopes, domains, subscriptions, what my twin takes from whom, digest on/off, paid channel pricing, hidden items |
| Public | public spaces, per-space permissions (answer, requests, bookings), followers, auto-post per space, rate limits, public page |
| Economy | business twin contact on/off, categories, price floors, frequency, task market on/off, collectives on/off per kind, payout account |
| Runs | trace viewer, filters, diff runs, quarantine, undo a run, cost dashboards, ledger export |
| Data | storage per source, two disk budgets, database, export (SQLite and JSON), honest delete (span, source, all), logs, media, retention, encryption at rest, debug export |

* * *
# Part D — Plan
## 29. Growth and distribution
### 29.1 Day-one channels, no budget
1. **Creator twins.** Creators of any size get a free twin that answers their fans from public content, saves them hours of repeated questions, and sells their taste channels. "Follow my twin" replaces "link in bio". Fans need a twin to subscribe, and every fan interaction is signed. Start with micro-creators in food, travel and AI in Bengaluru and on X.
  
2. **Twin-made content.** Users post pages, videos and recaps made by their twin to Instagram, TikTok, YouTube and X, where consumption already happens. Public learning spaces about topics become pages that rank and get shared. Every artifact carries the card link.
  
3. **Signed outreach.** Every email, message and call the twin makes on the owner's behalf is signed and declared. Each one is an impression on a human or a business, with the faster path offered when coordination happens.
  
4. **The developer ecosystem.** Open protocol, open node, skill SDK, OpenClaw and Hermes skill compatibility, and an MCP server that exposes the twin's memory to Claude, ChatGPT, Cursor and every other agent. Listing in those ecosystems is distribution inside other companies' products. Each skill built by a developer brings that skill's users.
  
5. **Build in public.** The founder's own narrative on X, GitHub and Hacker News, the way OpenClaw and Cursor spread, aimed at beachhead one.
  

```
   creators ──► fans need a twin ──┐
   twin-made content ──► viewers ──┤
   signed outreach ──► recipients ─┼──► new twin ──► groups · family · business twins ──► more twins
   open skills + MCP ──► devs ─────┤            ▲                                        │
   build in public ──► prosumers ──┘            └────────────────────────────────────────┘
```
### 29.2 Product-led loops
1. Groups: shared spaces, group money and group scheduling only work fully when the group is on twins, and the group needs each member on it to settle.
  
2. Families: one member sets up everyone; the voice twin brings parents; verified calls bring the protective.
  
3. The twin does the inviting. Every time it reaches a human without a twin it offers the faster path. The user never sends an invite.
  
4. Provisional identities: friends' twins already hold a provisional you; claim your handle and number to answer for yourself, as Truecaller made names claimable by uploading everyone's contacts.
  
5. Tenure and founding numbers: twin since 2026, twin number 4,812.
  
6. Business twins: each brings its customers.
  
### 29.3 The identity mechanics
1. Must-have: the chaos on the phone stops, the things never done get done, the family and groups run themselves, consumption gets an outcome, and it is free with the model already paid for.
  
2. Personal: the first words are the first true chapter of the life story with evidence.
  
3. Personality: the twin speaks in the owner's voice per audience, and everyone hears it when the twin speaks to them; the face and the sticker pack make it visible.
  
4. Unique look: the card and the face are generated from the owner's life and choices.
  
5. Status: draws, adoptions, firsts, match, trust, reliability, reach, tenure, verification level, and the monthly and yearly recap people share.
  
6. Sticky: group ledgers, family safety, pairwise coordination that only works while both stay, tenure, the address others use.
  
7. FOMO: Rohan's twin mentioned you; Ma's twin needs you; who asked your twin about you this week; five of eight in the trip have twins and the plan is moving without you.
  
8. Claim now: scarce handles, founding numbers, the provisional you.
  
9. Viral: signed replies, twin email and number in bios, recaps, stickers, pages.
  
10. Circles: the twin invites; families through the one who sets up everyone; groups through money and plans; work through shared spaces; fans through creators.
  
### 29.4 Geography
1. India: WhatsApp groups and families, the twin on the owner's own number, the voice twin, verified calls against scams, Hinglish and every Indian language.
  
2. United States: beachhead one through developer communities, then families through iMessage and the family setup. The mass US market waits for the network.
  
3. European Union: launch as early as the US. Meta's agents arrive late, Instinct and Town are absent, and local-first with user-held keys is a sales point no lab can make.
  
4. Middle East and South East Asia: WhatsApp-first, data-localization rules that favour local-first, no incumbent agent, language mix as the feature.
  
5. Not China.
  
### 29.5 Later levers
1. OEM preinstall deals and carrier bundles, which Indian phone makers and carriers sell and which put the app on tens of millions of devices.
  
2. Organization twins: a school, an apartment association, a gym or an office gets a twin that members' twins talk to for notices, fees, visitors and bookings. Each onboards its whole cluster.
  
3. Regulatory identity in India: registration as a consent manager under the DPDP Act and as an Account Aggregator client, so the twin is legally the user's data agent and can pull bank, insurance and investment data with consent, which no app-based observer can get.
  
## 30. Execution plan
Each phase ends in a release in real users' hands. The unit of planning is days, three tracks run in parallel, and nothing waits for a phase boundary that could ship earlier.

```
   PHASE 1                      PHASE 2                        PHASE 3
   parity · proof · protocol    phone · address · network      open beta · ecosystem · market
   · capture                    · taste
   ─────────────────────────    ───────────────────────────    ────────────────────────────
   Mac + WhatsApp + connectors  iOS v1 · Android v1            public beta IN · US · EU
   browser executor             twin number + email · calls    adapter & skill SDK · MCP out
   proactive execution          twin-to-human · twin-to-twin   business twins · creator program
   proof surface · spaces UI    group money · tiers            collectives v1 · market v1
   SuperTwin ID · spec public   taste · card · face · address   video · Windows · home box
   live mode on Mac             twin-made content v1           org twins pilot
   family setup · voice twin
   life story · DeepSeek eval
   24x7 keep-awake · own cloud
```
### 30.1 Phase 1: parity, proof, protocol, capture
1. Connectors: Gmail, Google Calendar, Apple Calendar and Reminders, iMessage on Mac, Slack, Drive and Docs, Notion, alongside WhatsApp, browser and screen.
  
2. The browser executor with cookie import, because booking is Instinct's proof point.
  
3. WhatsApp self-chat and iMessage as conversation surfaces, with short replies, personality and reactions.
  
4. Proactive execution parity: tasks run to the gate without prompting, scheduled steps, monitors, follow-ups, multi-day persistence.
  
5. Live mode on the Mac end to end: state gate, burst, executor-lite, surface router, nudge cards, brief.
  
6. The proof surface and the spaces and tasks views for parallel work: why, trace, scheduled, processed, authority, you-told-me versus I-inferred; the ledger.
  
7. SuperTwin ID keypair on device; the protocol specification and identity format published.
  
8. Unrecoverable capture on Mac: ambient audio, screen attention, clipboard; the tenure counter.
  
9. Shared spaces, family setup, and the voice twin for parents by phone call.
  
10. The life story with its fixed chapters.
  
11. Brain: DeepSeek V4 Flash and V4.1 Flash evaluated on the golden set for understanding and on real browser tasks for execution; metering and the free allowance.
  
12. 24x7: keep-awake on Mac and the one-click own-cloud image.
  
### 30.2 Phase 2: phone, address, network, taste
1. iOS app, version one: chat and voice, approvals, Needs you, spaces, ambient audio with Live Activity, the keyboard, share sheet, location, calendar, contacts, health, Action button and Shortcuts.
  
2. Android app, version one: notification listener, call screening, SMS, ambient audio, location, share sheet, keyboard.
  
3. The twin email and the twin number; outbound calls to businesses; inbound through conditional forwarding on iOS and natively on Android; the inbound gate.
  
4. Twin-to-human coordination over the twin's own addresses; twin-to-twin over the protocol with directory and relay; verified signatures in the interface.
  
5. Group money over UPI and local rails.
  
6. Password handling through the system keychain and 1Password.
  
7. Paid tiers live.
  
8. Taste channels, subscriptions, matchmaking, the card, the face and sticker pack, the master address.
  
9. Twin-made content: public pages and the monthly recap.
  
### 30.3 Phase 3: open beta, ecosystem, market
1. Public beta in India, the United States and the European Union on Mac, iPhone and Android.
  
2. Adapter and skill SDK; OpenClaw and Hermes skill compatibility; MCP servers as tools; the MCP server that exposes memory to other agents.
  
3. Business twins, invite-only, for a hundred local services; creator twins program with paid channels.
  
4. Collectives, version one: buyer collectives with request for quotes by outreach.
  
5. Task market, version one: task broadcast, business responses, fee.
  
6. Twin-made video; Windows; the home box as an option; organization twins pilot.
  
### 30.4 Cadence and build rules
1. One workflow per track, one agent per task with a structured report, a gate agent and a release agent per phase.
  
2. Any worker runs against a scratch home and a non-production port; no detached processes; zero live model calls in unit tests; stated call counts before anything that spends money.
  
3. Every correction from a real user drafts a golden eval case. No prompt ships that scores worse.
  
4. Every phase ships with the proof surface showing its own state: what is captured, indexed, processed, scheduled, and what authority permitted what.
  
## 31. Success metrics
North star: hours handed back per user per day.

| Area | Metric | Target |
| --- | --- | --- |
| Value | Tasks done per day per user | ≥ 10 |
| Value | Transactional tasks done per day | ≥ 2 |
| Value | Estimated time saved per day | ≥ 60 min |
| Activation | First true chapter of the life story on screen after first connect | ≤ 2 min |
| Coverage | Events filed into an episode or marked no-signal | 100% |
| Freshness, hot | Event touching open state, to understood, median | ≤ 60 s |
| Freshness, cold | Every other event, to understood | ≤ 10 min |
| Task quality | Surfaced tasks the user keeps | > 90% |
| Nudge precision | Nudges that named the right goal | > 95% |
| Nudge value | Nudges opened or acted on | > 40% |
| Proof | Answers about user data with citations and coverage | 100% |
| Trust | Approvals granted without edit | > 90% |
| Corrections | Corrections per 100 items | < 1% |
| Safety | Gated steps without approval token | 0   |
| Cost | Understanding spend per user per month on our models | ≤ $3 |
| Retention | Daily active after 30 days | ≥ 60% |
| Tenure | Median days of unrecoverable capture per active user | rising |
| Network | Active users with at least one other twin in a shared space or family | > 50% |
| Network | Twin-to-twin threads settled without human chat | > 90% |
| Communication | Inbound calls and messages handled by the gate without the owner | tracked, rising |
| Taste | Users with at least one subscription in each direction | > 30% |
| Taste | Adoptions per channel per month | tracked, rising |
| Public | Public questions answered without owner | > 90% |
| Growth | New users arriving through creators, content, signed outreach and the ecosystem | > 70% of new users |
| Market | Fee per active user per month, once live | tracked |
## 32. Non-goals
1. No cloud copy of raw data on our servers. Ever.
  
2. No autonomous payments or private sends. The two gates are always the user's.
  
3. No paid APIs. No private-API scraping libraries on real accounts.
  
4. No algorithmic feed. The twin surfaces work and taste, never content for its own sake.
  
5. No ads on any surface. Business twins reach the user's twin only through the market, and the user is paid.
  
6. No second datastore. The graph, the index and the world model live in one SQLite database.
  
7. No closed network. The protocol is public from Phase 1.
  
8. No manufactured entertainment.
  
9. No dependence on a single channel, model provider or platform.
  
## 33. Open questions
1. Local LLM: which fast passes are safe to move on-device first, and on which hardware floor?
  
2. DeepSeek-class execution: which browser tasks pass, and where must frontier still run?
  
3. Twin number economics: telecom partner cost per number per month, and which countries allow it without carrier-level KYC friction.
  
4. Taste privacy: how to compute match and adoptions with scoped exchange so neither twin learns more than the owners allowed.
  
5. Collective anonymity: what aggregate is safe to send in an RFQ without exposing a member.
  
6. Market pricing floors and the platform share need a market test.
  
7. Persistent cached session as an alternative to bundling: simulated at 693 calls a day, 6 s median latency and about $61 a month on frontier, and far less on flash. Revisit once prompt caching is measured across the CLI door.
  
8. Screen event rate is the largest assumption in every cost figure. Measure it in the first week of real users.
  
9. Which parts of the reference node, if any, should be licensed to prevent a closed fork from claiming the protocol.
  
10. The voice twin for parents: VoIP on the parent's own number, or a number the family owns?
  
## 34. Risks
1. Instinct or Meta opens its network first and takes the open position. Mitigation: publish the protocol in Phase 1.
  
2. Apple restricts the keyboard, background audio or call forwarding paths. Mitigation: the Mac and the twin number carry iOS; Android is unaffected.
  
3. DeepSeek-class models fail at browser execution. Mitigation: metered frontier execution and bring-your-own keys; flash for understanding regardless.
  
4. Meta acts against linked-device use of WhatsApp. Mitigation: the twin number, iMessage, email and the app; WhatsApp is one channel of several.
  
5. Anthropic or OpenAI restrict third-party use of consumer subscriptions. Mitigation: OpenRouter and API keys and our own metered tier in Phase 1.
  
6. Parity work outruns the team while Instinct ships weekly. Mitigation: the phase plan and the agent-driven build system; ship in days.
  
7. Taste channels feel like a feed or like surveillance. Mitigation: named-person channels only, one-tap curation, nothing hidden leaves the device, no global ranking.
  
8. Collectives and the market attract regulation. Mitigation: consent, scopes, escrow and disputes in the protocol; the consent-manager registration in India.
  
9. Cold start of the network. Mitigation: single-player parity so the first user stays long enough to bring the second; twin-to-human coordination so the network has value at one.
  
10. Always-on audio draws legal challenge in two-party-consent jurisdictions. Mitigation: on-device processing, transcripts only, declared recording where the law requires, per-jurisdiction defaults.
  
## 35. Glossary
1. **Adoption**: an action a subscriber took on something from a person's taste channel, verified by both twins.
  
2. **Approval gates**: the two actions that always need the owner's tap, sending to a private person and moving money, opened by a single-use signed token.
  
3. **Approval token**: the single-use signed token minted by a tap. The only key to a gate.
  
4. **Arc**: a narrative thread of the user's life that spaces belong to.
  
5. **Assistant**: the single-player product: observer, memory, spaces, tasks, executor, conversation, calls.
  
6. **Backfill**: processing of history that exists when a source is connected or a window is widened. Never nudges.
  
7. **Behavioral memory**: a rule that changes how the twin acts.
  
8. **Brain**: the models that run each step, per-step configurable, local, cheap cloud, frontier or the user's own.
  
9. **Bridge**: a deterministic cross-source join key: URL, phone, order id, mail thread, call id, twin thread id.
  
10. **Bundle**: a few minutes of life across all sources. The unit of a live model call.
  
11. **Burst**: four or more content-new events on one stream inside 180 s with no flush yet. The second hot condition.
  
12. **Business twin**: a twin for a business that answers customers' twins, takes orders and pays to respond in the task market.
  
13. **Card**: the twin's public face, seen by anyone who reaches it.
  
14. **Circle**: a relationship ring in the CRM. Drives priority, tone, lead times, scopes and gate defaults.
  
15. **Claim**: one structured statement about a person or the world, with evidence, confidence, validity, supersession.
  
16. **Cold window**: the idle and max timers for cold events, default 300 s / 540 s. Never fires on an empty accumulator.
  
17. **Collective**: a group of twins with a shared objective acting together.
  
18. **Coverage index**: per source, per date range, what exists and what was never captured.
  
19. **Creator twin**: a twin with a large public scope that answers fans and sells taste channels.
  
20. **Critic**: the pass that grades writes before commit.
  
21. **Directory**: the mapping from handle to public key and master address, with verification level.
  
22. **Draw**: a subscription to a person's taste channel; counted per domain.
  
23. **Episode**: one burst of activity about one thing in one stream. The evidence unit.
  
24. **Event**: one captured thing. Immutable.
  
25. **Event log**: the append-only store of all events. Source of truth.
  
26. **Executor**: the agent loop performing one task. **Executor-lite** is the bounded version for prepared actions from the live path.
  
27. **Face**: the stylized likeness of the owner that identifies the twin.
  
28. **Family setup**: one member creating twins for the rest of the family, including voice twins.
  
29. **First**: verifiable earliness in consuming something.
  
30. **Follow-up**: a task created by the completion of another.
  
31. **Golden set**: hand-labelled evals run against the real model, grown from corrections.
  
32. **Group money**: the twin-kept ledger of who owes whom in a group, settled with the payment gate.
  
33. **Hot event**: an event touching open state, or addressed to the twin, or a message from another twin. Flushes immediately.
  
34. **Inbound gate**: the policy deciding who and what may reach the person and what the twin may share or do in reply.
  
35. **Index window / Understand window**: per source, what is kept and searchable, and what is sent to the model.
  
36. **Ledger**: the auditable record of everything the twin did, decided, scheduled, was told and inferred, with time and money as columns.
  
37. **Life story**: the structured, evidence-backed narrative of the owner with fixed chapters.
  
38. **Live mode**: the twin acting on what the user is doing right now, within a minute, on the surface they are on.
  
39. **Master address**: the directory entry with every public-facing way to reach the owner and the twin.
  
40. **Match**: taste compatibility between two people in a domain.
  
41. **Matchmaking**: the twin finding content, places and events for the owner through the channels of people whose taste predicts theirs.
  
42. **Node**: one person's twin as running software with identity, keys, memory, brain, hands and addresses.
  
43. **Nudge**: a card delivering finished work or a needed answer. One of six kinds. Auto-closes in 60 s.
  
44. **Numbers**: phone numbers and email addresses issued to twins.
  
45. **Packer**: code that adds context to a bundle.
  
46. **Proof surface**: the views that make beliefs, actions, schedules, processed ranges and authority inspectable.
  
47. **Propose-only mode**: the early default where inferred spaces go to a review queue.
  
48. **Prospective memory**: a future intention with a horizon and decay.
  
49. **Protocol**: the published format and rules for twin-to-twin messages.
  
50. **Provisional person**: a person built from mentions alone, claimable by that person later.
  
51. **Public store**: the separate store the public twin reads.
  
52. **Relay**: the store-and-forward service for encrypted twin messages; sees ciphertext only.
  
53. **Reliability**: how fast and well a twin settles things with other twins and businesses.
  
54. **Roster**: resolved participants injected into every prompt.
  
55. **Scope**: what a twin may share with another twin, granted per person or circle.
  
56. **Self-reported**: provenance of a claim stated by the user in their own words. Outranks inferred.
  
57. **Signature**: the cryptographic signature from the SuperTwin ID private key on every twin message, approval and routed call or message.
  
58. **Skill / how-to**: a reusable playbook per site or task type, authored after success, replayed at zero model cost, repaired and refreshed when it breaks.
  
59. **Space**: one goal across all streams. Holds summary, latest, plan, tasks, people, claims, taste, enrichment, evidence.
  
60. **State gate**: the sub-100 ms lookup that decides whether an event flushes now or waits.
  
61. **Stream**: where events happen: a chat, an app session, a domain day, a document, a mail thread, a call, a room.
  
62. **Subscription**: one twin following another's taste channel.
  
63. **SuperTwin ID**: the device-generated keypair that is the owner's portable identity in the network.
  
64. **Surface router**: decides where an artifact or question is delivered.
  
65. **Sweep**: the retrieval run at every space birth that pulls related past episodes into the new space.
  
66. **Task market**: where a user's task is broadcast, with consent and scope, to business twins that pay to respond, with most of the money going to the user.
  
67. **Taste**: the cross-platform record of what a person consumed, saved, visited, bought, read, watched and listened to, kept as an asset.
  
68. **Taste channel**: a curated, scoped stream of a person's taste in one domain.
  
69. **Tenure**: how long the twin has been capturing the owner's life, and how much unrecoverable data it holds.
  
70. **Thin context**: not enough packed context to decide safely. Produces a question, never a guess.
  
71. **Tier**: processing class of a stream, 1 to 4, from engagement and business type.
  
72. **Tone memory**: how the user talks to one person, group or platform.
  
73. **Trace**: the record of one model call: prompt, context, output, cost.
  
74. **Trust**: the size of a person's consent graph.
  
75. **Twin-made content**: pages, videos, cards and recaps the twin renders from the owner's spaces, channels and ledger for the owner to share.
  
76. **Twin number / twin email**: the addresses issued to the twin that the owner gives to the world.
  
77. **Unrecoverable data**: data that exists only if captured live and cannot be synced later by anyone.
  
78. **Unsorted**: the holding area for episodes with no space yet.
  
79. **Verified network**: the identities in the directory whose owners passed possession and, optionally, government identity checks.
  
80. **Voice**: the twin's speaking voice on calls, standard with the owner's habits by default, a consented and declared clone optionally.
  
81. **Voice twin**: a twin for a person who will never install an app, reached and reaching by phone call.
