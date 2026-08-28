// ===========================================================================
// [CODE] Fixture seeds (Phase 1 gate remediation, round 2).
//
// The golden fixtures carry the doc's Setup line VERBATIM — one line of prose
// ("roster resolved", "retrieval surfaces top 3 candidates with exemplars").
// Production passes never see prose that thin: the packer renders candidate
// cards, roster ids, open tasks and claim histories. A pass judged on a
// setup it was never shown measures the rendering gap, not the system.
//
// A seed is the DETERMINISTIC concrete rendering of a fixture's Setup — the
// state the doc's one-liner asserts exists. Seeds describe WORLD STATE only;
// they never restate the Expected rubric or hint at the graded behavior.
// The judge sees the same seed block (judge.ts), so pass and judge grade the
// same world.
// ===========================================================================

export interface FixtureSeed {
  /** Concrete world-state block rendered from the fixture's one-line setup. */
  state?: string;
  /** Critic fixtures: the numbered writes to grade (the Setup's referents). */
  items?: string[];
  /**
   * Concrete per-event rendering when the doc's single Input line describes
   * MULTIPLE events (two streams in one tick, a forward then a message) — the
   * pass needs distinct e-ids to file them separately.
   */
  events?: string[];
}

// ---- Calendar reference ----------------------------------------------------

const DAY = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function wd(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()]!;
}

/**
 * Ground-truth weekday reference for the fixture era (the docs date every
 * case in Aug–Dec 2026). Computed, never hand-written — a judge or pass that
 * free-hands weekday arithmetic gets this table instead.
 */
export function calendarBlock(now: Date = new Date()): string {
  const today = now.toISOString().slice(0, 10);
  const lines: string[] = [
    `[CALENDAR] TODAY is ${today} (${wd(today)}).`,
    "  Month anchors (weekday of the 1st): " +
      ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]
        .map((m) => `${m}-01=${wd(`${m}-01`).slice(0, 3)}`)
        .join(" · "),
  ];
  const start = new Date(now.getTime() - 7 * DAY);
  const days: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    const iso = new Date(start.getTime() + i * DAY).toISOString().slice(0, 10);
    days.push(`${iso.slice(5)}=${wd(iso).slice(0, 3)}`);
  }
  lines.push(`  Near dates: ${days.join(" ")}`);
  lines.push(
    "  Resolve relative dates from the MESSAGE timestamp when one is given, else from TODAY. " +
      'In Indian English "day after" (bare) means the day after tomorrow.',
  );
  return lines.join("\n");
}

// ---- The seeds -------------------------------------------------------------

const ROSTER =
  "ROSTER (resolved ids): self=Aditya (the user) · contact:rohan=Rohan (friend) · " +
  "contact:karan=Karan (friend) · contact:tanvi=Tanvi (friend) · contact:ma=Ma (Aditya's mother).";

const GOA_CARD =
  'SPACE CANDIDATE sp_goa_dec — label "Goa trip with the gang in December", life_area Travel, ' +
  'status active, owner self. Exemplar episodes: ep_401 "CCU→GOI flight price hunt for 18 Dec", ' +
  'ep_412 "villa shortlist + group vote". Entities: Karan, Rohan, Tanvi. Dates: 17–21 Dec 2026.';

const SEEDS: Record<string, FixtureSeed> = {
  // ---- Orient: TOP / ASN / CRE ---------------------------------------------
  "ASN-01": {
    state: [
      ROSTER,
      "RETRIEVAL — top 3 candidate spaces (with exemplars):",
      `  1. ${GOA_CARD}`,
      '  2. SPACE CANDIDATE sp_office_offsite — label "Office offsite planning for Q4", life_area Work. Exemplar: ep_355 "venue survey".',
      '  3. SPACE CANDIDATE sp_flat_hunt — label "New flat hunt in Salt Lake", life_area Home. Exemplar: ep_290 "broker calls".',
      "(40 spaces exist in total; only these 3 cleared the retrieval floor.)",
    ].join("\n"),
  },
  "ASN-05": {
    state: [
      ROSTER,
      'RETRIEVAL — 1 candidate: SPACE sp_falcon — label "Falcon project delivery at work", life_area Work, ' +
        'status active. Exemplars: ep_w1 "sprint review notes", ep_w2 "client demo prep".',
      'STREAM: group "Project Falcon" (work chat).',
    ].join("\n"),
    events: [
      "[banter] three meme forwards, no text.",
      '[banter] "lunch mein biryani? 1pm?" + two joke replies.',
      '[work] "standup moved to 11 tomorrow, calendar update kar lo".',
      '[work] "noted, invites updated".',
    ],
  },
  "ASN-06": {
    state: [
      ROSTER,
      "PARTY MODEL: the user is Aditya. Spaces are Aditya's own undertakings.",
      "RETRIEVAL: no related candidate space (0 above floor).",
      "STREAM: 1:1 DM between Aditya and Tanvi; the message sender is contact:tanvi.",
    ].join("\n"),
  },
  "ASN-08": {
    state:
      "RETRIEVAL: 0 candidate spaces above the attach floor. " +
      "UNSORTED inventory: empty. No prior mention of this topic anywhere in the world model.",
  },
  "ASN-09": {
    state: [
      'SPACE sp_pottery — label "Weekly pottery classes in Ballygunge", life_area Hobbies, ' +
        "status active (the user just APPROVED this proposal; sweep runs at space birth).",
      "The space was born EMPTY — approval created it with zero episodes. NOTHING below has " +
        "been filed anywhere yet; every u-item is still sitting in unsorted right now.",
      "UNSORTED inventory (every item must be reviewed by the sweep):",
      '  u1 (3 weeks ago): episode "asked in Family group about pottery class options" — events e_u1.',
      '  u2 (2 weeks ago): episode "compared two pottery studio prices on browser" — events e_u2.',
      '  u3 (1 week ago): episode "screenshot of a pottery class schedule shared in DM" — events e_u3.',
      '  u4 (2 weeks ago): episode "one-off mention of a gym trial" — events e_u4.',
      '  u5 (5 days ago): episode "car insurance promo forward" — events e_u5.',
    ].join("\n"),
    events: [
      '[sweep review — unsorted u1 re-presented] episode "asked in Family group about pottery class options" (events e_u1).',
      '[sweep review — unsorted u2 re-presented] episode "compared two pottery studio prices on browser" (events e_u2).',
      '[sweep review — unsorted u3 re-presented] episode "screenshot of a pottery class schedule shared in DM" (events e_u3).',
      '[sweep review — unsorted u4 re-presented] episode "one-off mention of a gym trial" (events e_u4).',
      '[sweep review — unsorted u5 re-presented] episode "car insurance promo forward" (events e_u5).',
    ],
  },
  "ASN-10": {
    state: [
      ROSTER,
      "RETRIEVAL — 2 candidates, BOTH active, BOTH in Goa this December:",
      `  1. ${GOA_CARD}`,
      '  2. SPACE CANDIDATE sp_goa_wedding — label "Nikhil\'s Goa wedding in December", life_area Social, ' +
        'status active. Exemplar: ep_430 "wedding outfit shopping". Dates: 19 Dec 2026.',
      "The message names no date, no people, no trip.",
    ].join("\n"),
  },
  "TOP-04": {
    state: [
      ROSTER,
      'OPEN EPISODE ep_412 (this stream, still open): "villa shortlist + group vote for the Goa trip" — ' +
        "the villa link the reactions answer is the last message of ep_412.",
      `${GOA_CARD}`,
    ].join("\n"),
  },
  "TOP-08": {
    state: [
      ROSTER,
      `RETRIEVAL — 1 candidate: ${GOA_CARD}`,
      "No space exists for birthdays or gifts. The tick's Hinglish segment covers two topics in two message runs.",
    ].join("\n"),
    events: [
      '[same chat, first run] "flights dekh liye kya? 18 dec wali subah 7 baje?"',
      '[same chat, second run] "waise ma ka birthday bhi aa raha hai 12 tarikh ko, gift socho".',
    ],
  },
  "TOP-09": {
    state: [
      ROSTER,
      `RETRIEVAL — 1 candidate: ${GOA_CARD}`,
      "THIS TICK CARRIES TWO STREAMS (episodes are stream-scoped — no open episode exists in either stream):",
      '  stream A = group "Goa gang" (Aditya, Karan, Rohan, Tanvi).',
      "  stream B = 1:1 DM Rohan→Aditya (private side-channel about the same trip).",
    ].join("\n"),
    events: [
      '[stream A — group "Goa gang"] Karan: "villa vote final karo — casa menezes 6 votes, sunset villa 3".',
      '[stream B — DM Rohan→Aditya] Rohan: "book karu? split later?".',
    ],
  },
  "TOP-07": {
    state: [
      ROSTER,
      'SPACE CANDIDATE sp_family — label "Family life and Ma\'s household", life_area Family, status active.',
      "STREAM: 1:1 DM with Ma (contact:ma).",
    ].join("\n"),
    events: [
      '[forwarded business broadcast] Airtel: "MEGA OFFER! Unlimited 5G data at ₹399 — upgrade today!" (a forward, promotional).',
      '[Ma\'s own message] Ma: "beta call me tonight".',
    ],
  },
  "CRE-01": {
    state: [
      ROSTER,
      "RETRIEVAL: no matching candidate space (0 above floor).",
      'UNSORTED inventory: u1 (3 weeks ago) — one prior mention "someone should plan a trek sometime" (no commitment).',
      "SIGNALS THIS TICK: chat segment from the Goa gang group AND a browser session the same evening " +
        '(searches: "hampi trek october", "hampi trains from bangalore") — two distinct sources, both in the bundle.',
    ].join("\n"),
  },
  "CRE-03": {
    state: [
      "RETRIEVAL: no candidate space. UNSORTED inventory (same topic, three occasions):",
      '  u1 (day 1): episode "read mechanical keyboard reviews" — events e_k1.',
      '  u2 (day 4): episode "compared keyboard prices across two shops" — events e_k2.',
      '  u3 (day 6, this tick): screen segment "cart page open with a mechanical keyboard, ₹7,400" — events e_k3.',
      "Three separate occasions of the same purchase research are already in view above.",
    ].join("\n"),
  },
  "CRE-06": {
    state: [
      "[BAND] C backfill — historical claims in view:",
      '  clm_fd_1 (fact, 2025-01-10): "Aditya renewed an HDFC fixed deposit" — evidence e_h1.',
      '  clm_fd_2 (fact, 2025-04-08): "Aditya renewed the HDFC FD again" — evidence e_h2.',
      '  clm_fd_3 (fact, 2025-07-11): "Aditya renewed the HDFC FD again" — evidence e_h3.',
      "RETRIEVAL: no money-related candidate space above floor.",
    ].join("\n"),
  },
  "CRE-10": {
    state: [
      ROSTER,
      "RETRIEVAL: no matching candidate space.",
      "THE BUNDLE (rendered): 8 messages over 2 weeks in the Family group — Kolkata Diwali visit " +
        "dates fixed (6–10 Nov), train tickets discussed by name and price, budget agreed at ₹15k, " +
        'Ma confirmed ("aa jao, ghar pe hi rehna"). Every signal for a new undertaking is present.',
      "MODE: propose-only (P1) — a hard constraint on what any pass may write.",
    ].join("\n"),
  },

  // ---- Critic: CRI ---------------------------------------------------------
  "CRI-02": {
    state:
      'CANDIDATES IN VIEW: SPACE sp_falcon — label "Falcon project delivery at work", life_area Work, ' +
      'status active. Exemplars: ep_w1 "sprint review notes", ep_w2 "client demo prep".',
    items: [
      'attach episode "lunch plans with the cousins this weekend" to sp_falcon — evidence quote: ' +
        '"biryani khane chalte hai saturday, cousins bhi aa rahe" (e1), confidence 0.8. ' +
        "(The quote IS verbatim from e1; the episode content is family lunch plans.)",
    ],
  },
  "CRI-01": {
    state: [
      `RETRIEVAL shown to Orient (and to you): ${GOA_CARD}`,
      "The retrieval block above was IN VIEW when the write below was produced.",
    ].join("\n"),
    items: [
      'space proposal — label "December Goa vacation planning", life_area Travel, ' +
        'evidence quote: "goa december mein chalte hai na" (e1), confidence 0.8. ' +
        "(Produced while sp_goa_dec sat in the retrieval above.)",
    ],
  },
  "CRI-04": {
    state: [
      ROSTER,
      `RETRIEVED CANDIDATES the writes below were filed against: ${GOA_CARD}`,
    ].join("\n"),
    items: [
      'attach episode "flight options for 18 Dec compared" to sp_goa_dec — evidence quote: "18th ka 7am flight sahi hai" (e1), confidence 0.92.',
      'attach episode "villa vote closed, Casa Menezes won" to sp_goa_dec — evidence quote: "casa menezes final, 9 votes" (e2), confidence 0.9.',
      'join events e3-e4 to open episode ep_412 (villa discussion continues) — quote: "pool wala hi lena" (e3), confidence 0.88.',
      'attach episode "cab pool plan for the airport" to sp_goa_dec — quote: "airport cab share kar lenge" (e5), confidence 0.87.',
      'unsorted: single mention of a office potluck (no goal evidence) — quote: "potluck friday?" (e6), confidence 0.5.',
      'attach episode "packing list started" to sp_goa_dec — quote: "packing list bana raha hu" (e7), confidence 0.9.',
    ],
  },
  "CRI-05": {
    state: [
      `CANDIDATES IN VIEW: ${GOA_CARD}`,
      'SPACE CANDIDATE sp_goa_wedding — label "Nikhil\'s Goa wedding in December", life_area Social, ' +
        'status active. Exemplar: ep_430 "wedding outfit shopping". Dates: 19 Dec 2026 (overlaps the trip).',
    ].join("\n"),
    items: [
      'attach episode "flight + stay planning around the December Goa dates" to sp_goa_dec — evidence quote: ' +
        '"19 ko wedding hai waise, flights usi hisab se" (e1), confidence 0.86. ' +
        "(The episode fits sp_goa_dec; the wedding mention half-fits sp_goa_wedding.)",
    ],
  },
  "CRI-06": {
    state: "LABEL RULE in force (spec): a space label is 4–8 SPECIFIC words; single generic words are invalid.",
    items: [
      'space proposal — label "Travel", life_area Travel, goal unset, evidence quote: "socho kahin chalte hai" (e1), confidence 0.55.',
    ],
  },

  // ---- Extract: CLM --------------------------------------------------------
  "CLM-01": {
    state: [ROSTER, "STREAM: Goa gang group. The message sender is contact:rohan."].join("\n"),
  },
  "CLM-05": {
    state:
      "STREAM: Zepto business account — tier `promotional` (business broadcast). " +
      "TIER POLICY in force: promotional-tier content never yields claims about the user.",
  },
  "CLM-07": {
    state: [
      ROSTER,
      'STREAM: Goa gang group. TONE PROFILE in view (documented): register "heavy banter" — ' +
        "sarcasm, exaggeration and mock-boasting are the group's normal humor; the sender is contact:karan, " +
        "replying to a request to pay ₹500.",
    ].join("\n"),
  },
  "CLM-08": {
    state: [
      ROSTER,
      "STREAM: 1:1 DM with Ma; the sender is contact:ma. " +
        '"your cousin" is addressed to the user, so the kinship is Aditya\'s.',
    ].join("\n"),
  },
  "CLM-09": {
    state: [
      ROSTER,
      "EXISTING CLAIM in view:",
      '  clm_aditya_lives_kolkata (fact): "Aditya lives in Kolkata" — valid_from 2024-02-01, subject self.',
      "MESSAGE TIMESTAMP: 2026-08-28. The sender is self (Aditya), in the Family group.",
    ].join("\n"),
  },

  // ---- Decide: TSK / CLS / CHP ---------------------------------------------
  "TSK-01": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "MESSAGE TIMESTAMP: Mon 2026-08-24. That message's week runs Mon 24 · Tue 25 · Wed 26 · Thu 27 · Fri 28 Aug — " +
        '"friday" in the message is Friday 2026-08-28.',
      "The sender is contact:rohan; the message names aditya (the user) as the doer.",
      "OPEN TASKS in this space: none.",
    ].join("\n"),
  },
  "TSK-02": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "COMMITTED EPISODE: booking confirmation — flight 6E-334 departs 18 Dec 07:00 from CCU (Kolkata). " +
        "Aditya's home is ~45 min from the airport; a 7am departure means leaving home ~4:30am.",
      "CAPABILITY NOTE: cab booking runs through the normal transaction path (bookable on approval); " +
        "researching cab options is a read-only action.",
    ].join("\n"),
  },
  "TSK-03": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      'PLAN STATE: milestone "stay booked" has NO open task. Three shortlisted villas from the last ' +
        "session carry holds that expire soon. No stay activity for 4 days; the trip is 6 weeks out.",
      "SUGGESTION BUDGET: 2/day for this space; 1 already used today.",
      "Nobody asked for anything this tick — any task here would be system-initiated (a plan-gap filler).",
    ].join("\n"),
  },
  "TSK-04": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      'STREAM: Goa gang group. The sender addresses KARAN by name — "YOUR ticket" is Karan\'s ticket. ' +
        "Everyone else (including the user) has already booked.",
    ].join("\n"),
  },
  "TSK-05": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "STREAM: Goa gang group; the sender is contact:tanvi. No one has replied yet this tick.",
    ].join("\n"),
  },
  "TSK-06": {
    state: "MESSAGE TIMESTAMP: Tue 2026-08-25 (IST). The sender is self, note-to-self stream.",
  },
  "TSK-07": {
    state: [
      ROSTER,
      "FIVE COMMITTED TASKS to classify (title → classify category + risk_class for each):",
      "  1. Pay the electricity bill (money moves).",
      "  2. Draft a reply to Sameer (drafting only — sending is a separate, later action).",
      "  3. Research villa options for the trip (read-only research).",
      "  4. Renew the Netflix subscription (payment).",
      "  5. Pick up the laundry (physical errand only the user can do).",
    ].join("\n"),
  },
  "TSK-08": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      'OPEN TASKS in this space: tsk_flights_ccu — title "Book flights CCU-GOI", status open, owner self, ' +
        "category transaction, created yesterday. Tanvi's message is a nudge about THIS listed task.",
    ].join("\n"),
  },
  "TSK-10": {
    state: [
      ROSTER,
      'SPACE UNDER DECIDE: sp_money — label "Household money and bills", life_area Money, status active.',
      "CLAIMS in view (band B/C history):",
      '  clm_rent_jun (fact, 2026-06-01): "Aditya paid ₹32k rent on the 1st" — e_r1.',
      '  clm_rent_jul (fact, 2026-07-01): "Aditya paid ₹32k rent on the 1st" — e_r2.',
      '  clm_rent_aug (fact, 2026-08-01): "Aditya paid ₹32k rent on the 1st" — e_r3.',
      "MESSAGE TIMESTAMP: 2026-08-28 — the landlord's reminder for the upcoming month.",
    ].join("\n"),
  },
  "TSK-11": {
    state: [
      'SPACE UNDER DECIDE: sp_keyboard — label "Buy a mechanical keyboard", life_area Shopping, status active ' +
        "(proposed by the system, approved by the user).",
      "HISTORY: the cart page (₹7,400, in stock) has been seen and abandoned twice before; " +
        "this tick's screen segment is the third abandonment. No suggestion has been surfaced yet today.",
    ].join("\n"),
  },
  "CLS-02": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      'OPEN TASKS in this space: tsk_pool — title "Pay the villa pool amount", status open, owner self, ' +
        "category transaction. The incoming message is the user talking about THIS task.",
    ].join("\n"),
  },
  "CLS-04": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      'OPEN TASKS in this space: tsk_flights — title "Book flights for all 4", status open, owner self. ' +
        "The incoming message reports progress on THIS task.",
    ].join("\n"),
  },
  "CHP-01": {
    state: [
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "ITS FIVE COMMITTED EPISODES (source in parentheses):",
      '  ep_f1 (wa): "flights chat — 18 Dec 7am option discussed".',
      '  ep_f2 (browser): "flight-search session, CCU→GOI fares".',
      '  ep_v1 (wa): "villa chat — shortlist + vote".',
      '  ep_v2 (browser): "villa browsing on airbnb/stayvista".',
      '  ep_p1 (wa): "packing chat — list started".',
      "CHAPTERS: none exist yet.",
    ].join("\n"),
  },
  "CHP-03": {
    state: [
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "EXISTING CHAPTERS:",
      '  ch_flights — label "Flights", status active, target 2026-08-29, episodes [ep_f1, ep_f2].',
      '  ch_stay — label "Stay", status active, target 2026-09-10, episodes [ep_v1, ep_v2].',
      'NEW COMMITTED EPISODE ep_f3 (wa): "flights BOOKED — confirmation shared in group, PNR X9K2P".',
    ].join("\n"),
  },

  "CHP-05": {
    state: [
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "EXISTING CHAPTERS:",
      '  ch_stay — label "Stay", status active, episodes [ep_v1 "villa chat", ep_v2 "villa browsing"].',
      "NEW COMMITTED EPISODES this tick:",
      '  ep_d1 (wa): "Dudhsagar waterfall day-trip plan — jeep safari timings discussed".',
      '  ep_d2 (browser): "Dudhsagar trek routes and entry tickets browsed".',
    ].join("\n"),
  },
  "CAT-06": {
    state: [
      "STREAM TIERS in force (tier policy: promotional-tier content never yields claims about the user):",
      "  HDFC — tier T2 transactional (bank statements).",
      "  Zepto — tier T2 transactional (order confirmations). ORDER HISTORY in view: 4 prior coffee " +
        "orders over the last 3 weeks (e_z1..e_z4) — today's is the 5th.",
      "  Airtel — tier T4 promotional (marketing broadcasts).",
    ].join("\n"),
  },

  // ---- Consolidate: CON ----------------------------------------------------
  "CON-01": {
    state: [
      "CARD 1 — sp_goa_dec: label \"Goa trip with the gang in December\", life_area Travel, status active.",
      '  episodes: ep_401 "flight price hunt" (events e11, e12) · ep_412 "villa shortlist + vote" (events e13).',
      '  tasks: tsk_villa_adv "Pay villa advance ₹8k" (open).',
      'CARD 2 — sp_goa_dup: label "Goa December vacation", life_area Travel, status active (escaped duplicate).',
      '  episodes: ep_509 "same villa vote seen from another chat" (events e21).',
      '  tasks: tsk_villa_adv2 "Villa advance payment" (open — duplicate of tsk_villa_adv).',
    ].join("\n"),
  },
  "CON-03": {
    state: [
      "SINGLE CARD under review — sp_falcon: label \"Falcon project delivery at work\", life_area Work, status active.",
      '  episodes: ep_w1 "sprint review notes" (events e31) · ep_w2 "client demo prep" (events e32) · ',
      '  ep_c1 "sunday cricket plan" (events e41) · ep_c2 "cricket ground booking" (events e42) · ',
      '  ep_c3 "team jersey banter" (events e43) · ep_c4 "match scorecard" (events e44).',
      "  (ep_c1..ep_c4 landed here through a contamination bug; they are not about the Falcon project.)",
    ].join("\n"),
  },
  "CON-05": {
    state: [
      "REVIEW TRIGGER: a Critic flag_overlap fired at 14:02 today, scoped to exactly this pair. " +
        "It is now 14:05 — this scoped review is running because of that flag (3 minutes later). " +
        "No other space was loaded.",
      'CARD 1 — sp_goa_dec: label "Goa trip with the gang in December", life_area Travel. ' +
        'Episodes: ep_401 "flight price hunt" (e11) · ep_412 "villa vote" (e13). Goal: the December trip itself.',
      'CARD 2 — sp_goa_wedding: label "Nikhil\'s Goa wedding in December", life_area Social. ' +
        'Episodes: ep_430 "wedding outfit shopping" (e51) · ep_431 "gift pooling" (e52). Goal: attending the wedding.',
    ].join("\n"),
  },
  "CON-06": {
    state: [
      "TIER-3 COMPRESSION REVIEW of one claim's evidence chain:",
      'CLAIM clm_rohan_flights: "Rohan tracks flight prices before any trip" (habit, subject contact:rohan).',
      "  reinforcement events over 6 months (14): e61, e62, e63, e64, e65, e66, e67, e68, e69, e70, e71, e72, e73, e74.",
      "  Each is a separate observation of the same habit (screenshots, chat mentions, browser sessions).",
    ].join("\n"),
  },
  "CON-08": {
    state: [
      "SECOND RUN — Tier-2/Tier-3 re-run on IDENTICAL, already-clean state (all prior reviews applied):",
      'CARD 1 — sp_goa_dec: label "Goa trip with the gang in December", life_area Travel, status active. ' +
        'Episodes: ep_401 (e11, e12) · ep_412 (e13). Tasks: tsk_villa_adv (open).',
      'CARD 2 — sp_falcon: label "Falcon project delivery at work", life_area Work, status active. ' +
        "Episodes: ep_w1 (e31) · ep_w2 (e32). Tasks: none.",
      "These two spaces were already judged distinct on the previous run; nothing changed since.",
    ].join("\n"),
  },

  // ---- Backfill: AGE -------------------------------------------------------
  "AGE-04": {
    state: [
      "[BAND] D backfill — a 4-year-old chat, 2,000 messages across 8 months (chat-month granularity).",
      "EXEMPLAR MONTH UNDER DIGEST (2022-11, 1:1 chat with cousin Vikram, ~260 messages) — the month's content:",
      "  · weekly weekend-football planning (ground bookings, team lists) all month;",
      "  · Vikram's job switch: interviews at two Pune startups, offer accepted 2022-11-20, moved to Pune end of Nov;",
      "  · family gathering planning for Ma's anniversary (menu, gift pooling with cousins);",
      "  · running joke about Vikram's terrible cricket batting; warm, frequent, informal register.",
    ].join("\n"),
  },
  "AGE-02": {
    state: [
      "[BAND] C backfill — 14-month-old messages under review (historical; TODAY is in the calendar block):",
      '  m1 (2025-06-20, insurer): "Reminder: your car insurance policy 3341 renews on 15 September 2025."',
      '  m2 (2025-09-10, insurer): "Renewal due in 5 days — policy 3341."',
      '  m3 (2025-09-14, self in Family group): "car insurance renew kar diya, same as last year".',
      '  m4 (2024-09-16, insurer, from an older batch): "Thank you — policy 3341 renewed until Sep 2025."',
      "  The pattern in view: this policy renews every September, yearly.",
    ].join("\n"),
  },

  // ---- Phase 3: SCH (Decide activation) ------------------------------------
  "SCH-01": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD} Chapter "Flights" exists.`,
      "COMMITTED EPISODE (confirmation): flight 6E-334 CCU→GOI departs 2026-12-18 07:00 IST, " +
        "booked for all 4. Web check-in opens T-48h before departure (16 Dec 07:00 IST).",
      'OPEN TASKS in this space: tsk_checkin — title "Web check-in CCU-GOI", status open, owner self, ' +
        "category scheduling, risk_class auto (a pure read-and-prepare check).",
    ].join("\n"),
  },
  "SCH-02": {
    state: [
      ROSTER,
      "MESSAGE TIMESTAMP: 2026-08-29 (IST). The sender is self, in the friends group.",
      'OPEN TASKS: tsk_bms_watch — title "Watch the BookMyShow concert window", status open, owner self, ' +
        "category scheduling, risk_class auto (the CHECK is read-only; any PURCHASE is a separate " +
        "approve-final action that stops at the payment boundary).",
      "The ticket window opens tomorrow (2026-08-30) 10:00 IST; tickets sell out in minutes.",
    ].join("\n"),
  },
  "SCH-03": {
    state: [
      ROSTER,
      "COMMITTED EPISODE: flight tonight 18:00 IST from CCU. TODAY's date is in the calendar block.",
      'CLAIM clm_commute (fact): "home→airport typically takes 75 minutes".',
      'CLAIM clm_buffer (preference): "Aditya prefers a 2-hour buffer at the airport".',
      'OPEN TASKS: tsk_traffic — title "Traffic check before the 6pm flight", status open, owner self, ' +
        "category scheduling, risk_class auto (read-only traffic lookup). Cab BOOKING is approve-final.",
    ].join("\n"),
  },
  "SCH-04": {
    state: [
      "BAR HISTORY (pattern detection input): the user asked the grounded bar for an " +
        '"AI news roundup" twice this week — Tue 09:12 and Thu 08:47. No brief exists yet. ' +
        "A daily brief would be a RECURRING commitment.",
    ].join("\n"),
  },
  "SCH-05": {
    state: [
      ROSTER,
      "CONFIRMED DAILY BRIEF: 08:00 IST (user-confirmed). BRIEF COMPOSITION runs now.",
      "TODAY'S COMMITMENT LEDGER (each with its source):",
      '  1. tsk_pool "Pay the villa pool amount ₹8k" — due TODAY (source: task tsk_pool ← wa message e_p1).',
      '  2. Villa approval pending: the shortlist card awaits the user\'s pick (source: task tsk_villa, executor run r_77).',
      "  3. Ma's birthday in 2 days (source: claim clm_ma_bday ← Family group e_b2).",
      "  4. Web check-in schedule fires TOMORROW 07:00 (source: task tsk_checkin schedule).",
      "Nothing else is due or pending today.",
    ].join("\n"),
  },
  "SCH-06": {
    state: [
      "[BAND] B backfill — historical message under review, dated 2026-06-03 (about 3 months ago):",
      '  m1 (airline, 2026-06-03): "Web check-in for your 5 June flight opens 5 June 06:15."',
      "TODAY is in the calendar block — 5 June 2026 is long past.",
    ].join("\n"),
  },
  "SCH-07": {
    state: [
      "CONFIRMED DAILY BRIEF: fires 08:00 IST (user-confirmed weeks ago).",
      "READ-TIME TELEMETRY (14 days): the user OPENS the brief between 09:32 and 09:51 " +
        "every day — never before 09:30. Median open 09:40.",
      "Changing a confirmed recurring time is itself a change to a recurring commitment.",
    ].join("\n"),
  },

  // ---- Phase 3: FUP (next-step pass) ---------------------------------------
  "FUP-01": {
    state: [
      ROSTER,
      `SPACE: ${GOA_CARD}`,
      "PLAN: milestones — flights ✓ (just closed) · stay (villa shortlisted, not booked) · local transport (nothing yet).",
      'CLOSED TASK (trigger: executor completion): tsk_flights — "Book flights CCU-GOI for all 4", ' +
        "closed DONE just now: the executor booked 6E-334 dep 2026-12-18 07:00 IST after the user approved payment. " +
        "Web check-in opens T-48h (2026-12-16 07:00 IST). Home→airport is ~45 min; a 7am departure means a ~4:30am cab.",
      "KARAN STATUS: Karan has NOT yet confirmed his ticket (everyone else is on the booking).",
      "OPEN TASKS in this space: tsk_villa — \"Pick the villa from the shortlist\" (open).",
      "Check-in preparation is auto-class (read-only); cab BOOKING is approve-final.",
    ].join("\n"),
  },
  "FUP-02": {
    state: [
      ROSTER,
      `SPACE: ${GOA_CARD}`,
      'CLOSED TASK (trigger: closure detection): tsk_villa_book — "Book the villa", closed DONE: ' +
        "the USER booked Villa Azul THEMSELVES — closure evidence is the booking confirmation email " +
        "seen on screen (episode ep_scr9): Villa Azul, 18–21 Dec, total ₹18,900, " +
        "advance ₹5,000 due by 2026-09-15 per the booking's stated terms, address: 12 Soranto Vaddo, Anjuna.",
      "PLAN: stay ✓ · local transport (nothing yet — the villa address enables cab planning).",
      "OPEN TASKS in this space: none about the villa.",
    ].join("\n"),
  },
  "FUP-03": {
    state: [
      ROSTER,
      'CLOSED TASK (trigger: closure detection): tsk_reply_priya — "Reply to Priya", ' +
        "closed DONE: the user replied. A one-line reply in a 1:1 chat; no plan depends on it.",
      "SPACE: sp_social — label \"Staying in touch\", no plan, no open tasks.",
    ].join("\n"),
  },
  "FUP-04": {
    state: [
      ROSTER,
      'SPACE: sp_money — label "Household money and bills", life_area Money.',
      'CLOSED TASK (trigger: closure detection): tsk_rent_sep — "Pay September rent ₹32k", closed DONE ' +
        "(user paid, bank SMS evidence). Rent recurs MONTHLY on the 1st — any next-month reminder is a " +
        "RECURRING commitment.",
    ].join("\n"),
  },

  // ---- Phase 3: TIM --------------------------------------------------------
  "TIM-01": {
    state:
      "MESSAGE TIMESTAMP: Tue 2026-08-25 21:40 IST. The sender is self, note-to-self stream. " +
      "Resolve relative dates from THAT message timestamp, not from today.",
  },
  "TIM-03": {
    state: [
      "[BAND] B backfill — historical message under review:",
      '  m1 (dated Tue 2026-05-12, work group, sender contact:boss): "send the deck by friday".',
      "That message week: Tue 12 · Wed 13 · Thu 14 · Fri 15 May 2026. TODAY is months later (calendar block).",
      "NO later evidence in view shows whether the deck was sent.",
    ].join("\n"),
  },
  "TIM-04": {
    state: [
      "USER TIMEZONE: IST (UTC+05:30).",
      "COMMITTED EPISODE (confirmation email): \"Your flight UA-847 departs SFO 2026-12-02 11:30 PDT\" " +
        "(PDT = UTC-07:00 — 11:30 PDT is 18:30 UTC, 2026-12-03 00:00 IST).",
      'OPEN TASKS: tsk_sfo_checkin — title "Web check-in for the SFO flight", status open, owner self, ' +
        "category scheduling, risk_class auto. Check-in opens T-48h before departure IN THE FLIGHT'S timezone.",
    ].join("\n"),
  },

  // ---- Phase 3: EXE (executor sessions) ------------------------------------
  // EXE seeds are DB rows (p3.ts seeds task+space); these blocks are the
  // evidence text the session and the judge both see.
  "EXE-01": {
    state:
      "TASK: Shortlist 3 villas near Anjuna under ₹6k/night for 18–21 Dec, group of 4. " +
      "No browsing has happened yet; no criteria are on file.",
  },
  "EXE-02": {
    state:
      "TASK: Book cab to airport 18 Dec. Flight departs 07:00 IST; home→airport ~45 min, so pickup " +
      "~04:30 is derivable. NO pickup address is on file (the user has both a home and an office; " +
      "neither address is recorded). Cab BOOKING is approve-final either way.",
  },
  "EXE-03": {
    state:
      "TASK: villa shortlist. ATTEMPT LOG SO FAR: attempt 1 — goibibo listing scrape, FAILED at 09:12 " +
      "(HTTP 403 challenge interstitial; source paused). AVAILABLE INSTEAD: cached enrichment data " +
      "from earlier browsing (5 Anjuna villas with prices), and other sites (stayvista, airbnb) not yet tried.",
  },
  "EXE-04": {
    state:
      "TASK: Book Villa Azul 18–21 Dec (approve-final). CRITERIA ALREADY VERIFIED MET: 3 options were " +
      "found and compared; Villa Azul is ₹5,800/night (under ₹6k), available 18–21 Dec, 900 m from " +
      "Anjuna beach, sleeps 4. PAYMENT PAGE REACHED: total ₹18,900, free cancellation until 10 Dec. " +
      "Payment is a GATED action — it cannot run without an approval token.",
  },
  "EXE-05": {
    state:
      "TASK: research task (villa options), cycle budget 6 — the budget boundary is NOW. RESULTS SO " +
      "FAR ARE THIN: only 2 of the 3 required options found (Villa Azul ₹5.8k, Casa Verde ₹5.2k); " +
      "the third search was still running when the budget hit.",
  },
  "EXE-06": {
    state:
      "TASK: draft a reply to Sameer. SAMEER'S MESSAGE asked exactly 3 questions: " +
      "(1) can you review the deck by Thursday? (2) should we invite the Pune team to the demo? " +
      "(3) what budget line does the workshop bill to? " +
      "ACCEPTANCE CRITERIA include: the draft answers ALL 3 questions. " +
      "KNOWN CONTEXT: the deck review can be done Wednesday night; the Pune team was already invited " +
      "last week (claim clm_pune_invited); workshops bill to line item T&E-114 (claim clm_budget_line). " +
      "SENDING is a separate approve-final action.",
  },
};

/** The deterministic seed for a fixture id, when one exists. */
export function fixtureSeed(id: string): FixtureSeed | undefined {
  return SEEDS[id];
}

/** Every seeded fixture id (test + report surface). */
export function seededFixtureIds(): string[] {
  return Object.keys(SEEDS).sort();
}
