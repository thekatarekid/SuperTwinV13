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
      "UNSORTED inventory (every item must be reviewed by the sweep):",
      '  u1 (3 weeks ago): episode "asked in Family group about pottery class options" — events e_u1.',
      '  u2 (2 weeks ago): episode "compared two pottery studio prices on browser" — events e_u2.',
      '  u3 (1 week ago): episode "screenshot of a pottery class schedule shared in DM" — events e_u3.',
      '  u4 (2 weeks ago): episode "one-off mention of a gym trial" — events e_u4.',
      '  u5 (5 days ago): episode "car insurance promo forward" — events e_u5.',
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
      "No space exists for birthdays or gifts.",
    ].join("\n"),
  },
  "TOP-09": {
    state: [
      ROSTER,
      `RETRIEVAL — 1 candidate: ${GOA_CARD}`,
      "THIS TICK CARRIES TWO STREAMS:",
      '  stream A = group "Goa gang" (Aditya, Karan, Rohan, Tanvi): villa vote messages.',
      '  stream B = 1:1 DM Rohan→Aditya: "book karu? split later?" (private side-channel about the same trip).',
    ].join("\n"),
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
      "MESSAGE TIMESTAMP: Mon 2026-08-24. The sender is contact:rohan; the message names aditya (the user) as the doer.",
      "OPEN TASKS in this space: none.",
    ].join("\n"),
  },
  "TSK-02": {
    state: [
      ROSTER,
      `SPACE UNDER DECIDE: ${GOA_CARD}`,
      "COMMITTED EPISODE: booking confirmation — flight 6E-334 departs 18 Dec 07:00 from CCU (Kolkata). " +
        "Aditya's home is ~45 min from the airport; a 7am departure means leaving home ~4:30am.",
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
};

/** The deterministic seed for a fixture id, when one exists. */
export function fixtureSeed(id: string): FixtureSeed | undefined {
  return SEEDS[id];
}

/** Every seeded fixture id (test + report surface). */
export function seededFixtureIds(): string[] {
  return Object.keys(SEEDS).sort();
}
