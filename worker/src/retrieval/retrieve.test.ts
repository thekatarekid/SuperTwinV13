// ===========================================================================
// THE REPRO (docs/v6-spec.md §1), pinned.
//
// "Do i have anything planned on sunday" retrieved the question
// (`sunday lunch chalna hai kahin?`) and the reply that asked where
// (`Can do. Place?`) and structurally excluded the answer: a Swiggy booking for
// `02 Aug 2026` sitting eight messages later in the same 18-message chat, and
// `booked oye kake` right behind it. The booking matched only on the stopwords
// `have`/`on` and landed at rank 25, behind `LIMIT 8`; `booked oye kake`
// matched nothing at all and could not be reached from the question by any
// ranking, because it shares no token with it.
//
// The fixture is the live corpus's shape: the real message text and the real
// reply edges of the "Weekend lunches" chat, plus the stopword-only noise from
// the other chats that outranked the booking (rank 1-24 was almost entirely
// rows matching only do/have/on/anything). Phone numbers and names are changed;
// the text, which is the only thing retrieval reads, is not.
//
// `legacyContextBlock` below is the retrieval this replaced, kept verbatim so
// the repro test proves the FIX and not just the fixture: it asserts the old
// pipeline misses the booking on exactly the data the new one finds it in.
// ===========================================================================

// Local, not UTC: "sunday" is a local-calendar fact and the whole point of the
// date work is that resolving it through UTC is silently one day off for five
// and a half hours of every day here.
process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-retrieval-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
// Tier 3 has no model on a test machine; keep it explicit rather than implied.
process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { retrieveContext } = await import("./retrieve.js");
const { formatContextBlock, shortEventId } = await import("./format.js");
const { buildGroundedContextSync } = await import("./index.js");
const { planQuery } = await import("./query.js");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const GROUP = "120363403964397563@g.us";
const CH_GROUP = `whatsapp:st:${GROUP}`;
const CH_PRIYA = "whatsapp:st:919000000011@s.whatsapp.net";
const CH_RASHMI = "whatsapp:st:919000000012@s.whatsapp.net";
const CH_WHATSAPP = "whatsapp:st:0@s.whatsapp.net";

const SELF = "whatsapp:ac:919000000001@s.whatsapp.net";
const RAHUL = "whatsapp:ac:919000000002@s.whatsapp.net";
const HRISHI = "whatsapp:ac:919000000003@s.whatsapp.net";
const PRIYA = "whatsapp:ac:919000000011@s.whatsapp.net";
const RASHMI = "whatsapp:ac:919000000012@s.whatsapp.net";
const WHATSAPP = "whatsapp:ac:0@s.whatsapp.net";

interface SeedEvent {
  stanza: string;
  channel: string;
  actor: string;
  ts: string;
  text: string;
  kind?: string;
  replyTo?: string;
  replyToText?: string;
  transcript?: string;
}

/** The repro chat, verbatim: 18 events, two of them reactions, in wire order. */
const WEEKEND_LUNCHES: SeedEvent[] = [
  {
    stanza: "3A56149F7F0E5DD8EDBE",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-27T03:38:16.000Z",
    text: "Odyssey coming weekend?",
  },
  {
    stanza: "3A19134A12F969389E66",
    channel: CH_GROUP,
    actor: SELF,
    ts: "2026-07-27T09:10:51.000Z",
    text: "Yo, Hrishi Dekh chuka hai. Mujhe khaas enthu nahi hai, maybe next month dekhunga. Not sure. \nTum dekh lo bro",
  },
  {
    stanza: "3B54FCB018810FE47684",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-27T09:13:05.000Z",
    text: "ok",
  },
  {
    stanza: "3B698EC76C2C1C91AC18",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-27T09:21:17.000Z",
    text: "sunday lunch chalna hai kahin?",
  },
  {
    stanza: "3B4A5BA682B0C95B06D2",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-27T09:21:36.000Z",
    text: "i booked sat imax koramangala",
  },
  {
    stanza: "3BA2B68F621DED767ABD",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-27T09:21:42.000Z",
    text: "@4883528814807 worth it hai na?",
  },
  {
    stanza: "3A162CE1E5C9769A30B0",
    channel: CH_GROUP,
    actor: HRISHI,
    ts: "2026-07-27T09:34:30.000Z",
    text: "Haan Haan. It’s a definite watch",
  },
  {
    stanza: "3BB4760757515CC65584",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-27T09:37:19.838Z",
    text: "🙏",
    kind: "reaction",
    replyTo: "3A162CE1E5C9769A30B0",
  },
  {
    stanza: "3A742421DABFA9AC0AE8",
    channel: CH_GROUP,
    actor: SELF,
    ts: "2026-07-28T07:47:48.000Z",
    text: "Can do. Place?",
    replyTo: "3B698EC76C2C1C91AC18",
    replyToText: "sunday lunch chalna hai kahin?",
  },
  {
    stanza: "3B0B44873B40D3174D93",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-28T08:36:15.000Z",
    text: "let’s give kalpaney another try? indiranagar one",
    replyTo: "3A742421DABFA9AC0AE8",
    replyToText: "Can do. Place?",
  },
  {
    stanza: "3A48A1305EAFC2B6028A",
    channel: CH_GROUP,
    actor: SELF,
    ts: "2026-07-28T08:36:40.000Z",
    text: "Oye kake nahi jaana ?",
  },
  {
    stanza: "3BE7518D6A651CF92237",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-28T08:37:10.000Z",
    text: "wahan bhi chal sakte hai",
  },
  {
    stanza: "3A448CA5448810EFD27F",
    channel: CH_GROUP,
    actor: SELF,
    ts: "2026-07-28T08:37:53.000Z",
    text: "Hrishi opinion?",
  },
  {
    stanza: "3A333CE0065BAEC975A1",
    channel: CH_GROUP,
    actor: HRISHI,
    ts: "2026-07-28T15:00:06.000Z",
    text: "Let’s go to New place!",
    replyTo: "3A48A1305EAFC2B6028A",
    replyToText: "Oye kake nahi jaana ?",
  },
  {
    stanza: "3A37429417908124D2D1",
    channel: CH_GROUP,
    actor: HRISHI,
    ts: "2026-07-28T15:00:23.000Z",
    text: "But yeh bhi karna hai. Next weekend!",
    replyTo: "3B0B44873B40D3174D93",
    replyToText: "let’s give kalpaney another try? indiranagar one",
  },
  {
    stanza: "4A1F3D41EC13728EC075",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-28T15:37:05.000Z",
    text:
      "Hey!\nI have made a booking on 02 Aug 2026, 01:00 PM for 4 guest(s) at Oye Kake, MG Road, Bangalore.\n" +
      "Please reach on time for a seamless experience and don't forget to pay your restaurant bill via Swiggy " +
      "Dineout to get the best exclusive restaurant & payment offers on dining day.\nCheckout the restaurant here",
  },
  {
    stanza: "3BEC8B2165759934CF83",
    channel: CH_GROUP,
    actor: RAHUL,
    ts: "2026-07-28T15:37:20.000Z",
    text: "booked oye kake",
  },
  {
    stanza: "3EB0022012014F6A1C6F2A",
    channel: CH_GROUP,
    actor: SELF,
    ts: "2026-07-29T06:51:52.000Z",
    text: "🙏",
    kind: "reaction",
    replyTo: "3BEC8B2165759934CF83",
  },
];

/**
 * The stopword noise. Every one of these outranked the booking on the live DB
 * with the old match string — they are short, so bm25 loves them, and they are
 * about nothing, so they were five of the eight slots. Several are NEWER than
 * the booking on purpose: recency must not be what rescues it.
 */
const NOISE: SeedEvent[] = [
  {
    stanza: "390769160167996-1",
    channel: CH_WHATSAPP,
    actor: WHATSAPP,
    ts: "2026-07-20T04:00:00.000Z",
    text: "*New: Use two accounts on the same phone* Now you can switch between accounts on one phone.",
  },
  {
    stanza: "3A78F840693957B596CB",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-22T05:12:00.000Z",
    text: "Sunday ko bhi dekhna is pad sakta hai",
  },
  {
    stanza: "3A8FD2C39D66F8AD9647",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-23T06:00:00.000Z",
    text: "Boys will wear anything random 😂",
  },
  {
    stanza: "3BB0EB0959971B5B44AD",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-24T07:00:00.000Z",
    text: "No, I seem to have fallen ill but the house search is still on",
  },
  {
    stanza: "AC9D8DD3E006327A1DEFB614EEEF71F3",
    channel: CH_RASHMI,
    actor: RASHMI,
    ts: "2026-07-25T08:00:00.000Z",
    text: "5 minute do",
  },
  {
    stanza: "3A754C02F0DD321A5726",
    channel: CH_RASHMI,
    actor: RASHMI,
    ts: "2026-07-26T09:00:00.000Z",
    text: "When do you leave for home?",
  },
  {
    stanza: "3A4BEE1BB493543E0859",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-27T10:00:00.000Z",
    text: "And a lot of them do",
  },
  {
    stanza: "3AAB1B74E1FB0E5968FA",
    channel: CH_RASHMI,
    actor: RASHMI,
    ts: "2026-07-28T11:00:00.000Z",
    text: "Have you watched it?",
  },
  {
    stanza: "3A8C58BC6E85541B093E",
    channel: CH_RASHMI,
    actor: RASHMI,
    ts: "2026-07-29T12:00:00.000Z",
    text: "Have a safe trip",
  },
  {
    stanza: "3AC9D79AD69A79F2CF76",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-29T13:00:00.000Z",
    text: "You have never tried?",
  },
  {
    stanza: "3A0419D85D4E85EF7C74",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-30T05:00:00.000Z",
    text: "I have shared photos above",
  },
  {
    stanza: "3ADC45E9CD8CB4C21666",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-30T06:00:00.000Z",
    text: "Yes they can if they have time",
  },
  {
    stanza: "3A30DDBF940F3BE6EFB3",
    channel: CH_PRIYA,
    actor: PRIYA,
    ts: "2026-07-30T07:00:00.000Z",
    text: "What’s going on?",
  },
  {
    stanza: "702B96FE6BF0971F0B",
    channel: CH_WHATSAPP,
    actor: WHATSAPP,
    ts: "2026-07-31T03:00:00.000Z",
    text: "*🤯 Did you know? Only your Set-Top Box can do this! 👇* Watch anything on the big screen.",
  },
  {
    stanza: "144BFBAFE9AF67C6BF",
    channel: CH_WHATSAPP,
    actor: WHATSAPP,
    ts: "2026-07-31T04:00:00.000Z",
    text: "Dear Customer, your Credit Card bill is due. You can now pay on the app.",
  },
];

const BOOKING_ID = `wa:${GROUP}/4A1F3D41EC13728EC075`;
const CONFIRMATION_ID = `wa:${GROUP}/3BEC8B2165759934CF83`;
const QUESTION_ID = `wa:${GROUP}/3B698EC76C2C1C91AC18`;
const PLACE_ID = `wa:${GROUP}/3A742421DABFA9AC0AE8`;

/** How a line prints an id: the stanza, not the 51-char whole of it (v7 §6). */
const shown = (id: string): string => shortEventId(id);

const QUERY = "Do i have anything planned on sunday";
/** Friday 31 Jul 2026, 14:30 in Asia/Kolkata. The Sunday asked about is 02 Aug. */
const NOW = new Date("2026-07-31T09:00:00Z");

function seed(): void {
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  db.prepare(
    `INSERT INTO app_state (key, value) VALUES ('source.whatsapp.self_identity', '919000000001@s.whatsapp.net')`,
  ).run();

  const channel = db.prepare(
    `INSERT INTO channels (id, source_id, name, kind, source_ext_id) VALUES (?, 'whatsapp', ?, ?, ?)`,
  );
  channel.run(CH_GROUP, "Weekend lunches", "group", GROUP);
  channel.run(CH_PRIYA, "Priya", "dm", "919000000011@s.whatsapp.net");
  channel.run(CH_RASHMI, "Rashmi", "dm", "919000000012@s.whatsapp.net");
  channel.run(CH_WHATSAPP, "WhatsApp", "dm", "0@s.whatsapp.net");

  const actor = db.prepare(
    `INSERT INTO actors (id, source_id, display_name, source_ext_id) VALUES (?, 'whatsapp', ?, ?)`,
  );
  actor.run(SELF, "Aditya", "919000000001@s.whatsapp.net");
  actor.run(RAHUL, "Rahul", "919000000002@s.whatsapp.net");
  actor.run(HRISHI, "Hrishi", "919000000003@s.whatsapp.net");
  actor.run(PRIYA, "Priya", "919000000011@s.whatsapp.net");
  actor.run(RASHMI, "Rashmi", "919000000012@s.whatsapp.net");
  actor.run(WHATSAPP, "WhatsApp", "0@s.whatsapp.net");

  const event = db.prepare(`
    INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text,
                        external_id, reply_to_external_id, reply_to_text, transcript)
    VALUES (@id, 'whatsapp', 'whatsapp', @channel, @actor, @ts, @kind, @text,
            @externalId, @replyTo, @replyToText, @transcript)
  `);
  for (const row of [...WEEKEND_LUNCHES, ...NOISE]) {
    const chatJid = row.channel.replace("whatsapp:st:", "");
    const externalId = `${chatJid}/${row.stanza}`;
    event.run({
      id: `wa:${externalId}`,
      channel: row.channel,
      actor: row.actor,
      ts: row.ts,
      kind: row.kind ?? "message",
      text: row.text,
      externalId,
      replyTo: row.replyTo ? `${chatJid}/${row.replyTo}` : null,
      replyToText: row.replyToText ?? null,
      transcript: row.transcript ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// The retrieval this replaced, verbatim (chat-grounding.ts before v6 §1). Kept
// so "the fix works" is a claim about the CHANGE and not about the fixture.
// ---------------------------------------------------------------------------

function legacyMatchQuery(q: string): string {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").replace(/[^\p{L}\p{N}_-]+/gu, "").trim())
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function legacyHits(query: string, limit = 8): { id: string; snip: string }[] {
  const match = legacyMatchQuery(query);
  if (!match) return [];
  return getDb()
    .prepare(
      `SELECT e.id AS id, snippet(events_fts, 0, '', '', '…', 18) AS snip
         FROM events_fts f
         JOIN events e ON e.rowid = f.rowid
        WHERE events_fts MATCH @q AND e.kind IS NOT 'reaction'
        ORDER BY rank
        LIMIT @limit`,
    )
    .all({ q: match, limit }) as { id: string; snip: string }[];
}

// ---------------------------------------------------------------------------

beforeAll(() => {
  runMigrations();
  seed();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("the repro: 'Do i have anything planned on sunday'", () => {
  it("the retrieval this replaced misses the booking and cannot reach the confirmation", () => {
    const hits = legacyHits(QUERY);
    const ids = hits.map((h) => h.id);

    expect(ids).toContain(QUESTION_ID); // it found the question…
    expect(ids).not.toContain(BOOKING_ID); // …and not its answer
    expect(ids).not.toContain(CONFIRMATION_ID);

    // Not a LIMIT problem for the confirmation: `booked oye kake` shares no
    // token with the question, so no k makes it reachable.
    const everything = legacyHits(QUERY, 500).map((h) => h.id);
    expect(everything).not.toContain(CONFIRMATION_ID);

    // And most of what it did return was stopword noise from other chats.
    const fromOtherChats = ids.filter((id) => !id.startsWith(`wa:${GROUP}/`));
    expect(fromOtherChats.length).toBeGreaterThanOrEqual(4);
  });

  it("surfaces the booking AND the message confirming it", () => {
    const block = buildGroundedContextSync(QUERY, { now: NOW }).block;

    expect(block).toContain(shown(BOOKING_ID));
    expect(block).toContain("02 Aug 2026");
    expect(block).toContain("at Oye Kake, MG Road, Bangalore");
    expect(block).toContain(shown(CONFIRMATION_ID));
    expect(block).toContain("booked oye kake");
    // The question and the reply that asked where are still there.
    expect(block).toContain(shown(QUESTION_ID));
    expect(block).toContain(shown(PLACE_ID));
  });

  it("puts today's date and the date 'sunday' means in the prompt", () => {
    const block = buildGroundedContextSync(QUERY, { now: NOW }).block;

    expect(block).toContain("Today is Friday 2026-07-31.");
    // Both Sundays, under the one word that produced them: nothing in the
    // question says which way it points.
    expect(block).toContain(
      'Dates the question refers to: "sunday" = Sunday 2026-08-02 (in 2 days) ' +
        "or Sunday 2026-07-26 (5 days ago).",
    );
  });

  it("finds the booking through the date, not through the stopwords", () => {
    const plan = planQuery(QUERY, NOW);
    expect(plan.terms).toEqual(["planned", "sunday"]);
    expect(plan.dropped).toEqual(["do", "have", "anything", "on"]);
    expect(plan.phrases).toContain("02 aug 2026");

    const ranked = retrieveContext({ query: QUERY, now: NOW }).ranked;
    const booking = ranked.find((r) => r.hit.id === BOOKING_ID);
    expect(booking).toBeTruthy();
    // It is a hit in its own right now — not a row rescued by expansion.
    expect(booking!.hit.matchedColumn).toBe("text");
  });

  it("recovers it from the window alone when the chat is too big to include whole", () => {
    const result = retrieveContext({
      query: QUERY,
      now: NOW,
      // Forces every section to be a window around its hits.
      wholeChannelMaxChars: 1,
    });
    expect(result.sections.every((s) => !s.whole)).toBe(true);

    const block = formatContextBlock(result);
    expect(block).toContain(shown(BOOKING_ID));
    expect(block).toContain(shown(CONFIRMATION_ID));
  });

  it("includes the whole chat when the whole chat is small enough", () => {
    const result = retrieveContext({ query: QUERY, now: NOW });
    const chat = result.sections.find((s) => s.channelId === CH_GROUP);
    expect(chat?.whole).toBe(true);
    // 18 events, two of them reactions, which retrieval never counts.
    expect(chat?.channelEventCount).toBe(16);
    expect(chat?.events).toHaveLength(16);
    expect(chat?.channelCharCount).toBeLessThan(4000);
  });

  it("keeps the reply thread attached to the hit", () => {
    const result = retrieveContext({ query: QUERY, now: NOW, wholeChannelMaxChars: 1 });
    const chat = result.sections.find((s) => s.channelId === CH_GROUP);
    const ids = chat!.events.map((e) => e.id);
    // `Can do. Place?` quotes the question; `let's give kalpaney another try?`
    // quotes that. Both arrive with it.
    expect(ids).toContain(PLACE_ID);
    expect(ids).toContain(`wa:${GROUP}/3B0B44873B40D3174D93`);
  });

  it("marks the hits, names the chat, and never emits a blank line", () => {
    const block = buildGroundedContextSync(QUERY, { now: NOW }).block;
    const lines = block.split("\n");

    expect(lines.some((l) => l.startsWith("## Weekend lunches — the whole chat"))).toBe(
      true,
    );
    const events = lines.filter((l) => /^[* ] \[evt /.test(l));
    expect(events.length).toBeGreaterThan(10);
    for (const line of events) {
      const body = line.replace(/^[* ] \[evt [^\]]+\] \S+ \S+ · [^:]+: /, "");
      expect(body.trim().length).toBeGreaterThan(0);
    }
    expect(events.some((l) => l.startsWith("* "))).toBe(true);
    expect(events.some((l) => l.startsWith("  "))).toBe(true);
  });

  it("renders the user's own messages as theirs, and times in local time", () => {
    const block = buildGroundedContextSync(QUERY, { now: NOW }).block;
    // 2026-07-28T07:47:48Z is 13:17 in Asia/Kolkata.
    expect(block).toContain(
      `[evt ${shown(PLACE_ID)}] 2026-07-28 13:17 · Aditya (the user):`,
    );
    expect(block).toContain('(replying to "sunday lunch chalna hai kahin?")');
  });

  it("reactions are never evidence", () => {
    const block = buildGroundedContextSync(QUERY, { now: NOW }).block;
    expect(block).not.toContain("3EB0022012014F6A1C6F2A");
  });
});

describe("ranking", () => {
  it("a stopword-only chat cannot outrank the chat that answers the question", () => {
    const result = retrieveContext({ query: QUERY, now: NOW });
    expect(result.sections[0].channelId).toBe(CH_GROUP);
  });

  it("recency is a term, not an ordering", () => {
    const result = retrieveContext({ query: QUERY, now: NOW });
    const ids = result.ranked.map((r) => r.hit.id);
    // `Sunday ko bhi dekhna is pad sakta hai` (22 Jul) still beats the newer
    // stopword noise, because the newer noise is not a match at all.
    expect(ids).toContain(`wa:919000000011@s.whatsapp.net/3A78F840693957B596CB`);
    expect(ids).not.toContain(`wa:0@s.whatsapp.net/144BFBAFE9AF67C6BF`);
  });

  it("a question with nothing to search for retrieves nothing", () => {
    expect(buildGroundedContextSync("   ", { now: NOW }).block).toBe("");
    expect(buildGroundedContextSync("zzqqxx-nothing-here", { now: NOW }).block).toBe("");
  });
});

describe("the match expressions this builds", () => {
  it("are all expressions FTS5 can actually parse", async () => {
    const { searchEventsRanked } = await import("../db/retrieval.js");
    const questions = [
      QUERY,
      "what's pending for the goa trip flights?",
      "kal kya plan hai bhai?",
      "did anyone reply about the house",
      "अगले हफ़्ते क्या है",
      "who booked it — and when?",
      'lunch" OR events_fts MATCH "x',
      "*",
      "NEAR(a b)",
      "-- ?? !!",
      "tomorrow / this weekend / next week",
    ];
    for (const question of questions) {
      const match = planQuery(question, NOW).match;
      if (match.length === 0) continue;
      expect(() => searchEventsRanked({ match, limit: 5 }), question).not.toThrow();
    }
  });
});

describe("the char budget", () => {
  it("spends what is left on the messages nearest the hits, and keeps every hit", () => {
    const full = retrieveContext({ query: QUERY, now: NOW });
    const hitIds = full.sections
      .flatMap((s) => s.events)
      .filter((e) => e.role === "hit")
      .map((e) => e.id);
    expect(hitIds.length).toBeGreaterThan(1);

    const squeezed = formatContextBlock(full, { maxChars: 1600 });
    expect(squeezed.length).toBeLessThan(2200);
    for (const id of hitIds) expect(squeezed).toContain(shown(id));
    // The far edges went first: the block no longer holds the whole chat.
    expect(squeezed).not.toContain("Odyssey coming weekend?");
  });

  it("starved, it keeps the strongest hits and gives up the weakest", () => {
    const full = retrieveContext({ query: QUERY, now: NOW });
    const ranked = full.sections
      .flatMap((s) => s.events)
      .filter((e) => e.role === "hit")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    const starved = formatContextBlock(full, { maxChars: 900 });
    expect(starved).toContain(shown(ranked[0].id));
    expect(starved).not.toContain(shown(ranked[ranked.length - 1].id));
    // And the chat that only ever matched a stopword is gone entirely.
    expect(starved).not.toContain("Sunday ko bhi dekhna");
  });
});
