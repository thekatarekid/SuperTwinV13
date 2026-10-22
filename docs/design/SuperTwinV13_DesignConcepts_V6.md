# SuperTwin V13 — Design Concepts V6
A critique of `SuperTwinV13_DesignMockApp_V6.html`, then alternate concepts. Diagrams over prose.

* * *
## 1. Honest verdict on the current mock
1. It is a dashboard for the person who built the pipeline. Not a product for a person who wants their life handled.
  
2. It shows everything the twin knows. It should show only what the user must see.
  
3. It fails the 5-second test. A stranger cannot say what the app does or what to tap first.
  

```
 WHAT THE SPEC PROMISES              WHAT THE MOCK SHOWS
 ┌──────────────────────┐            ┌──────────────────────────────────┐
 │  "Do, then show."    │            │ 11 tabs · 8 panels · 60+ rows    │
 │  A second you.       │    vs      │ 40 chips · 14 settings panes     │
 │  Never in the way.   │            │ evidence strips on every card    │
 └──────────────────────┘            └──────────────────────────────────┘
```

* * *
## 2. Critical review — what is wrong, specifically
### 2.1 Structure
1. **Eleven tabs.** Consumer apps carry three to five. Eleven means eleven places to lose a thing.
  
2. **Home is eight panels.** Needs you, Prepared, Today, Spaces, Review, Recent understanding, Who I am, the bar. No single focus.
  
3. **Everything has equal weight.** A ₹8,400 payment looks like "Rohan prefers aisle seats".
  
4. **No progressive disclosure.** Every card is fully open. Nothing collapses. Nothing waits to be asked.
  
### 2.2 Language
1. **Internal vocabulary leaks.** Episodes, claims, watermark, burst, propose-only mode, T2, hop budget, hub-node. These are pipeline words.
  
2. **Every row has a metadata tail.** `Admin · HDFC Ergo · due Sep 9 · form filled · payment gate`. The user needs one clause.
  
3. **Chips are used as decoration.** Forty pills, six colours, no legend. Colour has no meaning left.
  
### 2.3 Visual
1. **Glass fights the scene.** Dense text over a moving, colourful sky. Contrast drops at dawn and evening.
  
2. **The scene is wallpaper.** It reflects nothing the user is doing. It could be a stock image.
  
3. **One card anatomy for everything.** A comparison table, a person, a setting and a timeline entry all wear the same box.
  
4. **No white space. No rhythm.** Rows of 13px text, 9px apart, to the edge of every card.
  
### 2.4 Behaviour
1. **The bar is buried.** The richest input in the product sits under the content, beside a pause button, next to a chip.
  
2. **No first-run story.** Onboarding is a sheet behind a debug button.
  
3. **No motion story.** The twin is "always with you" but nothing breathes, arrives, or leaves.
  
4. **Settings expose the engine.** Retrieval hop limits are not a consumer setting. They are a debug menu.
  
### 2.5 Adversarial read — what a harsh reviewer says in one line each
1. "It's a CRM with a sunset."
  
2. "Who reads an evidence strip on a home screen?"
  
3. "Why is 'Who I am' on Home? I know who I am."
  
4. "Tell me one thing to do. You gave me thirty."
  
5. "The best feature (the twin already did it) is the smallest text on the screen."
  
6. "I can't find the off switch, but I can find the reranker model."
  
7. "Where is the twin? I see lists. I don't see a second me."
  

* * *
## 3. Principles for the redesign
1. **Show three things or fewer.** Everything else is one gesture away.
  
2. **The twin speaks first, in one sentence.** Lists come after, on request.
  
3. **Done beats to-do.** Lead with what the twin finished. It is the product.
  
4. **Plain words only.** No word the user did not say themselves.
  
5. **One accent colour. Colour means "needs you". Nothing else is coloured.**
  
6. **The scene is the clock.** Time of day is information, not wallpaper.
  
7. **Levels, not tabs.** Sentence → card → detail. Zoom in, never navigate sideways.
  

* * *
## 4. Concepts
Each concept is a whole-app direction. They can be mixed.
### Concept A — "One Line"
The overlay opens as a single sentence. Nothing else. Tap to unfold.

```
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │                                                          │
 │                                                          │
 │            3 things need you. 6 done for you.            │
 │                                                          │
 │                      [ show me ]                         │
 │                                                          │
 │                                                          │
 │            ⌕  ask, or tell me to do something            │
 └──────────────────────────────────────────────────────────┘

 tap "show me" ─►

 ┌──────────────────────────────────────────────────────────┐
 │  NEEDS YOU                                               │
 │  ┌────────────────────────────────────────────────────┐  │
 │  │  Pay ₹8,400 to HDFC Ergo for car insurance         │  │
 │  │  Everything is filled in.            [ Pay ]  skip │  │
 │  └────────────────────────────────────────────────────┘  │
 │  ┌────────────────────────────────────────────────────┐  │
 │  │  Dinner with Rohan, Sat 8pm at Toit?               │  │
 │  │  His twin said yes.               [ Yes ]  change  │  │
 │  └────────────────────────────────────────────────────┘  │
 │  ┌────────────────────────────────────────────────────┐  │
 │  │  Ma asked about the train. AC or sleeper?          │  │
 │  │                              [ AC ]  [ Sleeper ]   │  │
 │  └────────────────────────────────────────────────────┘  │
 │                                                          │
 │  done for you (6)  ·  your day  ·  everything            │
 └──────────────────────────────────────────────────────────┘
```

1. The home state is one sentence and one input.
  
2. Each card is one plain sentence and one primary action.
  
3. Everything else is a text link at the bottom, not a tab.
  
### Concept B — "Deck"
One card at a time, full width. Swipe or arrow through. Like flipping through what your assistant left on your desk.

```
 ┌──────────────────────────────────────────────────────────┐
 │  ‹                       2 of 5                       ›  │
 │                                                          │
 │      ┌──────────────────────────────────────────┐        │
 │      │                                          │        │
 │      │   Goa trip                                │        │
 │      │                                          │        │
 │      │   I compared 6 villas.                   │        │
 │      │   Villa Sol fits best:                   │        │
 │      │   pool, ₹5,400 a night, free cancel.     │        │
 │      │                                          │        │
 │      │   ┌────────────────────────────┐         │        │
 │      │   │  [ villa photo ]           │         │        │
 │      │   └────────────────────────────┘         │        │
 │      │                                          │        │
 │      │        [ Book it ]     see all 6         │        │
 │      │                                          │        │
 │      └──────────────────────────────────────────┘        │
 │                                                          │
 │   ● ● ○ ○ ○        ⌕ ask                  ⏸  🎙        │
 └──────────────────────────────────────────────────────────┘
```

1. Cards are ordered by "value dies first" (spec §14.4), so the first card is always the right one.
  
2. Keyboard: → next, ← back, Enter approve, Esc close. Zero navigation.
  
3. "See all 6" expands the table inside the card. Never a new screen.
  
### Concept C — "River"
The day is a horizontal line. The sun on the scene is "now". Things sit where they happen in time.

```
 ┌──────────────────────────────────────────────────────────────────┐
 │        ☀                                                         │
 │  ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ skyline ~~~~~~~~~~~~~~~~~  │
 │                                                                  │
 │  07:00    09:15      12:00      now 14:10     18:00   20:00      │
 │ ───●────────●──────────●───────────┃────────────●───────●──────  │
 │  brief   Ma asked    Kindle        ┃          pool    dinner     │
 │   ✓      about       moved ✓       ┃         Karan    Rohan      │
 │          train ?                   ┃                  cab 7:15 ✓ │
 │                                    ┃                             │
 │                          ┌─────────┴──────────┐                  │
 │                          │ You're looking at  │                  │
 │                          │ Anjuna villas.     │                  │
 │                          │ I compared 6.      │                  │
 │                          │ [ show ]           │                  │
 │                          └────────────────────┘                  │
 │                                                                  │
 │  drag to scrub the day  ·  scroll for other days                 │
 └──────────────────────────────────────────────────────────────────┘
```

1. The scene and the content share one axis: time. The background stops being wallpaper.
  
2. Past = done (✓). Future = planned. Now = the one card that matters.
  
3. Timeline, Today and Calendar collapse into one surface.
  
### Concept D — "Chat, and only chat"
The whole app is a conversation. Every screen is a card inside the thread.

```
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │  twin   Morning. 3 things today, 1 needs you.            │
 │                                                          │
 │  twin   ┌──────────────────────────────────┐             │
 │         │ Car insurance renews Wed.        │             │
 │         │ Form filled. ₹8,400.  [ Pay ]    │             │
 │         └──────────────────────────────────┘             │
 │                                                          │
 │   you   what did we decide about goa?                    │
 │                                                          │
 │  twin   18–21 Dec. Under ₹6k a night. Rohan books        │
 │         flights.                     ↳ from 3 messages   │
 │                                                          │
 │  twin   ┌──────────────────────────────────┐             │
 │         │ ◆ Villa Sol · ₹5,400 · pool      │             │
 │         │   [ Book ]   compare 6           │             │
 │         └──────────────────────────────────┘             │
 │                                                          │
 │  ┌────────────────────────────────────────────────────┐  │
 │  │ ⌕ say anything                                🎙  │  │
 │  └────────────────────────────────────────────────────┘  │
 │   spaces · people · calendar  (open as cards here)       │
 └──────────────────────────────────────────────────────────┘
```

1. Matches the spec's own claim: talking to the twin is the richest input.
  
2. Spaces, people and calendar are answers, not destinations.
  
3. Familiar to every consumer on earth. Zero learning.
  
### Concept E — "Three doors"
Cut eleven tabs to three. Everything fits.

```
        FOR YOU                DONE                 YOUR WORLD
   ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
   │ needs a tap     │   │ what I finished │   │ spaces          │
   │ needs an answer │   │ today, this wk  │   │ people          │
   │ ready to review │   │ with receipts   │   │ calendar        │
   └─────────────────┘   └─────────────────┘   └─────────────────┘
          ▲                      ▲                      ▲
          │                      │                      │
     the default            the delight            the archive

   Library · Browser · Scratchpad · Public · Settings  ─►  behind "…"
```

```
 ┌──────────────────────────────────────────────────────────┐
 │        [ For you · 3 ]    Done · 6    Your world    …    │
 │                                                          │
 │   Pay ₹8,400 for car insurance          [ Pay ]          │
 │   Dinner Sat 8pm at Toit?               [ Yes ]          │
 │   AC or sleeper for Ma?           [ AC ] [ Sleeper ]     │
 │                                                          │
 │   ⌕                                                      │
 └──────────────────────────────────────────────────────────┘
```

1. "For you" opens by default and is usually short. Empty is the goal.
  
2. "Done" is the marketing. It is where the user feels the product.
  
3. Tools live behind one "…". They are not peers of the user's life.
  
### Concept F — "Rooms"
Spaces are rooms you walk into. Big, visual, few.

```
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
 │   │  🏖          │  │  🎂          │  │  🚀          │   │
 │   │              │  │              │  │              │   │
 │   │  Goa, Dec    │  │  Ma's        │  │  v13 launch  │   │
 │   │  villa ready │  │  birthday    │  │  doc ready   │   │
 │   │  to book     │  │  in 14 days  │  │              │   │
 │   │      ● 1     │  │              │  │              │   │
 │   └──────────────┘  └──────────────┘  └──────────────┘   │
 │                                                          │
 │   ┌──────────────┐  ┌ ─ ─ ─ ─ ─ ─ ┐                      │
 │   │  🛡          │    + new room                         │
 │   │  Insurance   │  │  or just     │                     │
 │   │  pay ₹8,400  │     tell me     │                     │
 │   │      ● 1     │  └ ─ ─ ─ ─ ─ ─ ┘                      │
 │   └──────────────┘                                       │
 │                                                          │
 │   sleeping: gym · hampi                                  │
 └──────────────────────────────────────────────────────────┘

 enter a room ─►

 ┌──────────────────────────────────────────────────────────┐
 │  ‹ rooms                                     Goa, Dec    │
 │                                                          │
 │   Villa Sol is ready to book. ₹16,200 for 3 nights.      │
 │                                        [ Book ]          │
 │                                                          │
 │   next   pay the pool → cabs → packing → check-in Dec 16 │
 │                                                          │
 │   with   Rohan · Tanvi · Karan                           │
 │                                                          │
 │   why?  ·  everything about this trip  ·  share          │
 └──────────────────────────────────────────────────────────┘
```

1. One room = one goal. The room shows one sentence and one action.
  
2. Goal, summary, latest, plan, claims, enrichment, evidence all live under "everything about this trip".
  
3. A dormant space is "sleeping". Not a status enum.
  
### Concept G — "Presence"
The twin is one visible thing: an orb. Its state is the interface. The overlay is rarely needed.

```
   menu bar             desktop (no overlay)
 ┌─────┐            ┌──────────────────────────────────────┐
 │  ◉  │            │                                      │
 └─────┘            │                                 ◉    │  ← breathing: watching
                    │                                      │
                    │                                 ◉ 3  │  ← needs you, count
                    │                                      │
                    │                           ┌───────┐  │
                    │                           │ ◉     │  │  ← click: one card
                    │                           │ Pay   │  │
                    │                           │ ₹8,400│  │
                    │                           │ [Pay] │  │
                    │                           └───────┘  │
                    │                                      │
                    │                                 ○    │  ← grey: paused
                    └──────────────────────────────────────┘

   hold the orb  ─►  talk.   drag onto the orb  ─►  give it something.
```

1. Most days the user never opens the overlay.
  
2. One object carries state, unread count, pause, and input.
  
3. The full overlay becomes "the archive", opened by choice.
  
### Concept H — "Levels"
Every object has exactly three sizes. The app is zoom, not navigation.

```
 LEVEL 1 · line          Pay ₹8,400 for car insurance        [ Pay ]

 LEVEL 2 · card    ┌───────────────────────────────────────────────┐
                   │ Pay ₹8,400 for car insurance                  │
                   │ HDFC Ergo. Renews Wed. Form is filled.        │
                   │ Card ending 4412.                             │
                   │                          [ Pay ]  change      │
                   └───────────────────────────────────────────────┘

 LEVEL 3 · full    ┌───────────────────────────────────────────────┐
                   │ Pay ₹8,400 for car insurance                  │
                   │ ─────────────────────────────────────────────  │
                   │ What I did    read the renewal mail Mon       │
                   │               collected RC, last policy       │
                   │               filled the form, 5/5 fields     │
                   │ Where from    mail from HDFC Ergo, Sep 1  ↗    │
                   │ Cost          4 calls · $0.03                 │
                   │ Change        [ not mine ] [ later ] [ edit ] │
                   └───────────────────────────────────────────────┘

   click  = one level deeper.   Esc = one level up.   nothing else.
```

1. Level 1 is the only thing on any list. Ten words max.
  
2. Evidence, trace, cost, corrections only exist at level 3.
  
3. Same rule for spaces, people, days, sources. One mental model.
  
### Concept I — "Brief"
Twice a day the twin tells a short story. Full-screen slides. Like stories on a phone.

```
 ┌──────────────────────────────────────────────────────────┐
 │ ▬▬▬▬ ▬▬▬▬ ▬▬▬▬ ▭▭▭▭ ▭▭▭▭                        7:00 am │
 │                                                          │
 │                                                          │
 │                                                          │
 │                 Rohan's twin said yes.                   │
 │                 Saturday, 8pm, Toit.                     │
 │                                                          │
 │                 I booked a cab for 7:15.                 │
 │                                                          │
 │                                                          │
 │                                                          │
 │                      [ great ]   change                  │
 │                                                          │
 │  ‹ tap                                          tap ›    │
 └──────────────────────────────────────────────────────────┘
```

1. One fact per slide. Big type. The scene behind it is the real morning or evening.
  
2. Five to eight slides. Under a minute.
  
3. After the brief, the app is quiet until something needs a tap.
  
### Concept J — "Ask first"
No home screen. The bar is the whole first screen. Results are answers, not pages.

```
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │                                                          │
 │   ┌────────────────────────────────────────────────┐     │
 │   │ ⌕  who recommended that place in goa▌         │     │
 │   └────────────────────────────────────────────────┘     │
 │                                                          │
 │     Tanvi, on 14 July.                                   │
 │     "Gunpowder in Assagao, best vindaloo."        ↗      │
 │                                                          │
 │     ─────────────────────────────────────────────        │
 │     add to Goa trip     ·     book a table               │
 │                                                          │
 │                                                          │
 │   3 need you  ·  6 done  ·  goa  ·  ma  ·  rohan         │
 └──────────────────────────────────────────────────────────┘
```

1. Empty bar shows the three counts and the three most alive topics. That is the whole home.
  
2. Answers come with one or two next actions. Never a screen to navigate to.
  
3. Spotlight-familiar. Power users live here.
  
### Concept K — "Inbox zero"
Only the gates. The app's job is to reach empty.

```
 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │   3 waiting for you                                      │
 │                                                          │
 │   ┌────────────────────────────────────────────────┐     │
 │   │ 💳  Pay ₹8,400 · car insurance      [ Pay ]  ✕ │     │
 │   ├────────────────────────────────────────────────┤     │
 │   │ 💬  Send to Ma · "AC ka book kar...  [ Send ] ✕ │     │
 │   ├────────────────────────────────────────────────┤     │
 │   │ 📅  Sat 8pm Toit with Rohan          [ Yes ]  ✕ │     │
 │   └────────────────────────────────────────────────┘     │
 │                                                          │
 │                                                          │
 │           everything else, I've got it.                  │
 │                    see what I did ›                      │
 │                                                          │
 └──────────────────────────────────────────────────────────┘

 when empty ─►

 ┌──────────────────────────────────────────────────────────┐
 │                                                          │
 │                                                          │
 │                      Nothing for you.                    │
 │                  Go live your life.                      │
 │                                                          │
 │                      6 done today ›                      │
 │                                                          │
 └──────────────────────────────────────────────────────────┘
```

1. The two hard gates and the one soft gate are the only rows.
  
2. Empty state is the success state. Design it first.
  
3. "See what I did" is the door to everything else.
  
### Concept L — "Phone on the desk"
One narrow column on desktop, same as the phone. One design, both devices.

```
       desktop, overlay                       phone
 ┌───────────────────────────────┐      ┌───────────────┐
 │        ░░ scene ░░            │      │  ░░ scene ░░  │
 │      ┌─────────────────┐      │      │               │
 │      │  Good evening.  │      │      │ Good evening. │
 │      │                 │      │      │               │
 │      │  ┌───────────┐  │      │      │ ┌───────────┐ │
 │      │  │ Pay ₹8,400│  │      │      │ │ Pay ₹8,400│ │
 │      │  │   [ Pay ] │  │      │      │ │   [ Pay ] │ │
 │      │  └───────────┘  │      │      │ └───────────┘ │
 │      │  ┌───────────┐  │      │      │ ┌───────────┐ │
 │      │  │ Sat 8pm?  │  │      │      │ │ Sat 8pm?  │ │
 │      │  │  [ Yes ]  │  │      │      │ │  [ Yes ]  │ │
 │      │  └───────────┘  │      │      │ └───────────┘ │
 │      │                 │      │      │               │
 │      │  ⌕  ·  🎙       │      │      │ ⌕  📷  🎙     │
 │      └─────────────────┘      │      └───────────────┘
 └───────────────────────────────┘
```

1. A 420px column cannot be crowded. The constraint does the design.
  
2. Big touch targets, one action per card, thumb-reachable input.
  
3. The scene fills the rest of the screen and finally has room to be beautiful.
  
### Concept M — "Scene is the state"
Keep the live scene, but make it mean something. Content changes the sky, not the clock alone.

```
   calm · nothing needed                needs you · 3
 ┌──────────────────────────┐       ┌──────────────────────────┐
 │  ☀   clear, wide, quiet  │       │  ☀   three small lights   │
 │                          │       │      hover over the city  │
 │                          │       │          ✦   ✦   ✦        │
 │ ~~~~~~~ skyline ~~~~~~~  │       │ ~~~~~~~ skyline ~~~~~~~  │
 │        (no card)         │       │  tap a light ─► the card │
 └──────────────────────────┘       └──────────────────────────┘

   twin working                       paused
 ┌──────────────────────────┐       ┌──────────────────────────┐
 │  ☀   a slow trail moves  │       │  ☁   grey, still, muted   │
 │      across the sky ···› │       │                          │
 │ ~~~~~~~ skyline ~~~~~~~  │       │ ~~~~~~~ skyline ~~~~~~~  │
 └──────────────────────────┘       └──────────────────────────┘
```

1. The scene answers "is anything needed?" before any text loads.
  
2. Working, paused, needs-you, quiet: four sky states, all wordless.
  
3. Cards float in the sky only when needed. Otherwise the view is empty on purpose.
  
### Concept N — "Receipts"
"Done for you" as the hero. A wall of small finished things. The feeling of a good assistant.

```
 ┌──────────────────────────────────────────────────────────┐
 │  Today I…                                                │
 │                                                          │
 │  ✓ moved Dad's clinic to Thu 11am, told Ma      5:45pm   │
 │  ✓ booked your cab for 7:15                     4:02pm   │
 │  ✓ compared 6 villas, 3 fit                     2:41pm   │
 │  ✓ pushed the Kindle delivery to 8pm           12:15pm   │
 │  ✓ filed the restaurant photo to Goa           3:30pm    │
 │  ✓ filled the insurance form                    8:10am   │
 │                                                          │
 │  That's about 1 h 40 m handed back.                      │
 │                                                          │
 │  this week ›                                             │
 └──────────────────────────────────────────────────────────┘
```

1. Every line is past tense, first person, one clause.
  
2. The time saved number is the north-star metric, shown to the user.
  
3. Any line opens to level 3 (Concept H) for "why" and "undo".
  
### Concept O — "Fewer words"
A rewrite pass. Same data, consumer language.

```
   BEFORE (mock)                             AFTER
   ─────────────────────────────────         ─────────────────────────────────
   Needs you · 3 · ordered by decay          3 things need you
   ▸ Pay insurance renewal ₹8,400            Pay ₹8,400 for car insurance
     HDFC Ergo · form filled · card ready ·    Form's done. Renews Wednesday.
     renews in 3 days · payment gate
   Prepared for you · same artifact,         Ready when you are
     one status
   Recent understanding                      (removed from home)
   claim · WhatsApp · ❝aisle only bhai❞      (level 3 only)
   propose-only mode · graduates after       Should I start a space for
     two clean weeks                           the TV you're looking at?
   watermark 2 min ago                       up to date
   Index · Understand windows                keep · read
   dormant                                   sleeping
   evidence strip ▂▃▅▂▃                      "why?" link
```

1. Ban list for the UI: episode, claim, bundle, burst, watermark, tier, trace, hop, artifact, enrichment, propose-only.
  
2. Every sentence: subject, verb, object. Under twelve words.
  
3. Numbers only when the user will act on them.
  

* * *
## 5. A recommended combination
```
  ┌────────────────────────────────────────────────────────────┐
  │  DEFAULT       Concept G · Presence (orb) + Concept M sky   │
  │                nothing on screen until something is needed  │
  ├────────────────────────────────────────────────────────────┤
  │  WHEN NEEDED   Concept A/K · one sentence, one card, one tap │
  ├────────────────────────────────────────────────────────────┤
  │  TWICE A DAY   Concept I · brief as slides                  │
  ├────────────────────────────────────────────────────────────┤
  │  WHEN ASKED    Concept J · bar, answers with next actions   │
  ├────────────────────────────────────────────────────────────┤
  │  WHEN CURIOUS  Concept E · For you · Done · Your world      │
  │                Rooms (F) inside "Your world"                │
  │                Levels (H) for every object                  │
  ├────────────────────────────────────────────────────────────┤
  │  ALWAYS        Concept O · plain words · one accent colour  │
  └────────────────────────────────────────────────────────────┘
```

1. Default is empty. That is the confidence of a product that does the work.
  
2. One tap from anything to the thing that needs you.
  
3. Depth exists, but only on request.
  

* * *
## 6. What to build as the next mock
1. Home = one sentence + up to three cards (Concept A). No tabs.
  
2. Three doors behind a swipe: For you · Done · Your world (Concept E).
  
3. Rooms grid for spaces (Concept F). Room view = one sentence, one action.
  
4. Levels for every object (Concept H). Evidence at level 3 only.
  
5. Sky states (Concept M). Manual switcher stays for the mock.
  
6. Brief as slides (Concept I), triggered from the mock bar.
  
7. The bar at the top, wide, alone (Concept J).
  
8. Apply the ban list (Concept O) before writing any string.
  
9. Settings: five items visible. "Advanced" hides the rest.
  
10. Design the empty state first. Then fill it, reluctantly.
