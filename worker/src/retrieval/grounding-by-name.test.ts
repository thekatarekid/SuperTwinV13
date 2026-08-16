// ===========================================================================
// THE REPRO (docs/v7-spec.md §6), pinned.
//
// "how is pranjali's health" returned her diet and ragi dosa and never
// mentioned the cold, the medicines or the doctors. "how is pranjali's cold"
// found them immediately — so the evidence was there and reachable, and the
// question about the PERSON could not reach it.
//
// The fixture is built to the measured shapes, not to the fix:
//
//   - `pranjali` is in exactly ONE indexed row in the whole database (an
//     unrelated selfie's auto-generated description), so the question degrades
//     to a bare topic search for `health` — which matches three documents
//     corpus-wide, one of them the diet line and one of them a marketing
//     broadcast literally called "Orange Health Updates";
//   - her chat is 231 events, far past the 120-event whole-inclusion cap, so it
//     is the one human chat in the database on the WINDOW side of that switch;
//   - it is dense: a message every ~35 seconds, so ±8 messages spans five
//     minutes. The doctors cluster sits 46 messages / 27 minutes from the
//     lexical hit, and "Exhaustion and cold" 141 messages away, on the day
//     before;
//   - several seeds were scraped YouTube pages matching only in
//     `link_scraped_text`, alive on recency weight, which then bought windows
//     of a chat nobody had asked about.
//
// `legacyBlock` is the retrieval this replaces, so "fixed" is a claim about the
// change and not about the fixture.
//
// The stand-in encoder at the bottom is a four-concept bag, honest about being
// one (the real weights are 129 MB the installer bundles). It is here because
// lever 6 is the ONLY thing that reaches "Exhaustion and cold": 141 messages and
// a day away, sharing no token with the question. The test says which lever
// carries which line, including with the tier switched off.
// ===========================================================================

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-by-name-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "0";

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { resolveChannelsByName } = await import("../db/retrieval.js");
const { retrieveContext } = await import("./retrieve.js");
const { focusMatch, focusSearch } = await import("./focus.js");
const { formatContextBlock, shortEventId } = await import("./format.js");
const { buildGroundedContext } = await import("./index.js");
const { planQuery } = await import("./query.js");
const { indexSemanticBatch, resetSemanticCacheForTests, semanticSearch } = await import(
  "./semantic.js"
);
const { forgetEmbedder, setEmbedder } = await import("./embedder.js");

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CH_PRANJALI = "whatsapp:st:919000000021@s.whatsapp.net";
const CH_RASHMI = "whatsapp:st:919000000022@s.whatsapp.net";
const CH_GHAR = "whatsapp:st:120363111111111111@g.us";
const CH_ORANGE = "whatsapp:st:919000000099@s.whatsapp.net";

const SELF = "whatsapp:ac:919000000001@s.whatsapp.net";
const PRANJALI = "whatsapp:ac:919000000021@s.whatsapp.net";
const RASHMI = "whatsapp:ac:919000000022@s.whatsapp.net";
const ORANGE = "whatsapp:ac:919000000099@s.whatsapp.net";

/** Her chat, in order. Index is the unit the spec's distances are measured in. */
const COLD = 59;
const DOCTORS = 154;
const DIET = 200;
const PRANJALI_EVENTS = 231;

/** Day 1 is two minutes a message; day 2 is 35 seconds a message. */
const DAY1_START = Date.parse("2026-07-24T04:00:00.000Z");
const DAY1_STEP_MS = 120_000;
const DAY1_COUNT = 100;
const DAY2_START = Date.parse("2026-07-30T12:30:00.000Z");
const DAY2_STEP_MS = 35_000;

/**
 * The lines the answer is made of. Every one of them is from the reported
 * transcript; only the phone numbers around them are invented.
 */
const ANSWER: Record<number, { text: string; self?: boolean }> = {
  [COLD]: { text: "Exhaustion and cold" },
  [DOCTORS]: { text: "Doctor ko dikhaya? medicines li?", self: true },
  [DOCTORS + 1]: { text: "Thanks! Already taking meds" },
  [DOCTORS + 2]: { text: "Throat is bad, shall start antibiotics today" },
  [DOCTORS + 3]: { text: "2 doctors kar toh rahe hai supervise virtually" },
  [DOCTORS + 4]: { text: "MD medicine" },
  // What the question returns TODAY, and the only row in her chat that the
  // word `health` can reach.
  [DIET]: { text: "Ragi dosa aaj bhi. Health first 💪" },
};

/**
 * Small talk. Nothing in it says health, cold, doctor or her name — and some of
 * it is the short function-word chatter that the old query, which kept `how`
 * and `is`, spent most of its eight slots on.
 */
const FILLER = [
  "achha",
  "is it done?",
  "how was the day",
  "is that ok",
  "how come",
  "haan bilkul",
  "kal batati hu",
  "abhi nikli hi hu office se",
  "ok done",
  "photo bhejti hu",
  "arre nahi yaar",
  "raat ko baat karte hai",
  "traffic bohot tha aaj",
  "meeting chal rahi thi",
  "lol",
  "hmm",
  "khaana ban gaya?",
  "bas thoda kaam bacha hai",
  "chalo theek hai",
  "subah jaldi uth gayi thi",
  "wo wala hi lena",
  "paise bhej diye",
  "call kar leti hu",
  "so rahi hu ab",
];

/** A WhatsApp stanza id is 20-odd chars; the block prints this and not more. */
function stanza(prefix: string, i: number): string {
  return `3${prefix}${String(i).padStart(3, "0")}D8F1C0B7A46E2`;
}

interface Seeded {
  id: string;
  channel: string;
  actor: string;
  ts: string;
  text: string | null;
  kind?: string;
  mediaDescription?: string;
  linkUrl?: string;
  linkTitle?: string;
  linkScrapedText?: string;
}

function pranjaliChat(): Seeded[] {
  const out: Seeded[] = [];
  for (let i = 0; i < PRANJALI_EVENTS; i++) {
    const at =
      i < DAY1_COUNT
        ? DAY1_START + i * DAY1_STEP_MS
        : DAY2_START + (i - DAY1_COUNT) * DAY2_STEP_MS;
    const answer = ANSWER[i];
    // Her diet photo, so "her diet and ragi dosa" is what the old retrieval
    // surfaces — a description, matching nothing the question asks.
    const isPhoto = i === DIET - 1;
    out.push({
      id: `wa:919000000021@s.whatsapp.net/${stanza("A", i)}`,
      channel: CH_PRANJALI,
      actor: answer?.self || i % 3 === 0 ? SELF : PRANJALI,
      ts: new Date(at).toISOString(),
      text: isPhoto ? null : (answer?.text ?? FILLER[i % FILLER.length]),
      kind: isPhoto ? "image" : "message",
      mediaDescription: isPhoto
        ? "A plate of ragi dosa with coconut chutney and a glass of buttermilk"
        : undefined,
    });
  }
  return out;
}

/**
 * The 53%. Six YouTube shorts whose SCRAPED pages carry the query's only topic
 * word, and a marketing broadcast whose name carries it too — the two chats the
 * measured block spent more than half of itself on.
 */
function noiseChats(): Seeded[] {
  const out: Seeded[] = [];
  const gharBase = Date.parse("2026-07-31T05:00:00.000Z");
  for (let i = 0; i < 6; i++) {
    out.push({
      id: `wa:120363111111111111@g.us/${stanza("B", i)}`,
      channel: CH_GHAR,
      actor: RASHMI,
      ts: new Date(gharBase + i * 600_000).toISOString(),
      text: null,
      linkUrl: `https://www.youtube.com/shorts/gh${i}`,
      linkTitle: `Ghar+ ${i}: 2BHK tour`,
      // One of them carries the query's only topic word; that is enough to
      // seed six windows of somebody else's chat, which is the complaint.
      linkScrapedText:
        "Subscribe for more. How to pick a flat. Comments are turned off. More " +
        "videos on the channel about kitchen storage and how much rent is fair " +
        (i === 5 ? "in this area. Health and safety checks before you move in." : "here."),
    });
  }

  const orangeBase = Date.parse("2026-07-31T06:00:00.000Z");
  const marketing = [
    "Orange Health: full body health checkup at 40% off this week. How to book: tap below.",
    "Orange: lab tests at home in 60 minutes, 7 days a week.",
    "Orange: monsoon package now live. Book before Sunday.",
  ];
  marketing.forEach((text, i) => {
    out.push({
      id: `wa:919000000099@s.whatsapp.net/${stanza("C", i)}`,
      channel: CH_ORANGE,
      actor: ORANGE,
      ts: new Date(orangeBase + i * 3_600_000).toISOString(),
      text,
    });
  });

  // The one indexed row in the database that carries her name, and the short
  // function-word chatter that bm25 loved when the question still contained it.
  const rashmiBase = Date.parse("2026-07-29T09:00:00.000Z");
  const rashmi = [
    "how are you doing today",
    "is that the one you wanted",
    "how much did it come to",
    "is he coming for the weekend",
    "how long does it usually take",
    "is it far from the station",
  ];
  rashmi.forEach((text, i) => {
    out.push({
      id: `wa:919000000022@s.whatsapp.net/${stanza("D", i)}`,
      channel: CH_RASHMI,
      actor: RASHMI,
      ts: new Date(rashmiBase + i * 900_000).toISOString(),
      text,
    });
  });
  out.push({
    id: `wa:919000000022@s.whatsapp.net/${stanza("E", 0)}`,
    channel: CH_RASHMI,
    actor: RASHMI,
    ts: new Date(rashmiBase + 6 * 900_000).toISOString(),
    text: null,
    kind: "image",
    mediaDescription: "A selfie of two women, Pranjali and Rashmi, outside a cafe",
  });
  return out;
}

/** Minutes between two of her messages, by index. */
function minutesApart(a: number, b: number): number {
  const at = (i: number): number =>
    i < DAY1_COUNT
      ? DAY1_START + i * DAY1_STEP_MS
      : DAY2_START + (i - DAY1_COUNT) * DAY2_STEP_MS;
  return Math.abs(at(b) - at(a)) / 60_000;
}

const QUERY = "how is pranjali's health";
/** Friday 31 Jul 2026, 14:30 in Asia/Kolkata. */
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
  channel.run(CH_PRANJALI, "Pranjali", "dm", "919000000021@s.whatsapp.net");
  channel.run(CH_RASHMI, "Rashmi", "dm", "919000000022@s.whatsapp.net");
  channel.run(CH_GHAR, "Ghar+", "group", "120363111111111111@g.us");
  channel.run(CH_ORANGE, "Orange Health Updates", "dm", "919000000099@s.whatsapp.net");

  const actor = db.prepare(
    `INSERT INTO actors (id, source_id, display_name, source_ext_id) VALUES (?, 'whatsapp', ?, ?)`,
  );
  actor.run(SELF, "Aditya", "919000000001@s.whatsapp.net");
  actor.run(PRANJALI, "Pranjali", "919000000021@s.whatsapp.net");
  actor.run(RASHMI, "Rashmi", "919000000022@s.whatsapp.net");
  actor.run(ORANGE, "Orange Health Updates", "919000000099@s.whatsapp.net");

  const event = db.prepare(`
    INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text,
                        external_id, media_description, link_url, link_title, link_scraped_text)
    VALUES (@id, 'whatsapp', 'whatsapp', @channel, @actor, @ts, @kind, @text,
            @externalId, @mediaDescription, @linkUrl, @linkTitle, @linkScrapedText)
  `);
  for (const row of [...pranjaliChat(), ...noiseChats()]) {
    event.run({
      id: row.id,
      channel: row.channel,
      actor: row.actor,
      ts: row.ts,
      kind: row.kind ?? "message",
      text: row.text,
      externalId: row.id.replace("wa:", ""),
      mediaDescription: row.mediaDescription ?? null,
      linkUrl: row.linkUrl ?? null,
      linkTitle: row.linkTitle ?? null,
      linkScrapedText: row.linkScrapedText ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// The retrieval this replaces: every token of the question, LIMIT 8, one flat
// ordering, and the message text as the snippet whatever column matched.
// ---------------------------------------------------------------------------

function legacyBlock(query: string, limit = 8): string {
  const match = query
    .split(/\s+/)
    .map((t) => t.replace(/["']/g, "").replace(/[^\p{L}\p{N}_-]+/gu, "").trim())
    .filter((t) => t.length > 1)
    .map((t) => `"${t}"`)
    .join(" OR ");
  const rows = getDb()
    .prepare(
      `SELECT e.id AS id,
              COALESCE(NULLIF(e.text, ''), e.media_description, e.link_title, '') AS body
         FROM events_fts f
         JOIN events e ON e.rowid = f.rowid
        WHERE events_fts MATCH @q AND e.kind IS NOT 'reaction'
        ORDER BY rank
        LIMIT @limit`,
    )
    .all({ q: match, limit }) as { id: string; body: string }[];
  return rows.map((r) => `[evt ${r.id}] ${r.body}`).join("\n");
}

// ---------------------------------------------------------------------------
// A stand-in encoder. Four concepts, one dimension each; not a language model,
// a fixture that behaves like one for the words this test needs.
// ---------------------------------------------------------------------------

const CONCEPTS = ["unwell", "food", "care", "home"] as const;

/**
 * How someone IS ("health", "cold") sits on one axis; what is being DONE about
 * it ("doctor", "meds") leans partly onto another, the way a real encoder puts
 * treatment near but not on top of a question about a person.
 */
const LEXICON: Record<string, number[]> = {
  health: [1, 0, 0, 0],
  cold: [1, 0, 0, 0],
  exhaustion: [1, 0, 0, 0],
  throat: [0.9, 0, 0.3, 0],
  doctor: [0.8, 0, 0.4, 0],
  doctors: [0.8, 0, 0.4, 0],
  medicines: [0.8, 0, 0.4, 0],
  medicine: [0.8, 0, 0.4, 0],
  meds: [0.8, 0, 0.4, 0],
  antibiotics: [0.8, 0, 0.4, 0],
  dosa: [0, 1, 0, 0],
  ragi: [0, 1, 0, 0],
  khaana: [0, 1, 0, 0],
  flat: [0, 0, 0, 1],
  ghar: [0, 0, 0, 1],
  rent: [0, 0, 0, 1],
};

const conceptEmbedder = {
  model: "test-health-v1",
  dim: CONCEPTS.length,
  async embed(texts: readonly string[]) {
    return texts.map((text) => {
      const v = new Float32Array(CONCEPTS.length);
      for (const word of text.toLowerCase().split(/[^a-z]+/)) {
        const weights = LEXICON[word];
        if (!weights) continue;
        weights.forEach((w, i) => {
          v[i] += w;
        });
      }
      return v;
    });
  },
};

/** The lines the answer is made of, as a reader would look for them. */
const CLINICAL = [
  "Exhaustion and cold",
  "Doctor ko dikhaya? medicines li?",
  "Thanks! Already taking meds",
  "Throat is bad, shall start antibiotics today",
  "2 doctors kar toh rahe hai supervise virtually",
  "MD medicine",
];

async function semanticSeeds() {
  setEmbedder(conceptEmbedder);
  resetSemanticCacheForTests();
  await indexSemanticBatch(1000);
  resetSemanticCacheForTests();
  return semanticSearch(QUERY);
}

beforeAll(() => {
  runMigrations();
  seed();
});

afterAll(() => {
  forgetEmbedder();
  resetSemanticCacheForTests();
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ===========================================================================

describe("the measured ground this stands on", () => {
  it("has her name in exactly one indexed row, and `health` in three", () => {
    const count = (match: string): number =>
      (
        getDb()
          .prepare(`SELECT COUNT(*) AS n FROM events_fts WHERE events_fts MATCH ?`)
          .get(match) as { n: number }
      ).n;
    expect(count('"pranjali"')).toBe(1);
    expect(count('"health"')).toBe(3);
  });

  it("her chat is past the whole-inclusion cap, and dense", () => {
    const result = retrieveContext({ query: QUERY, now: NOW });
    const hers = result.sections.find((s) => s.channelId === CH_PRANJALI);
    expect(hers?.channelEventCount).toBe(PRANJALI_EVENTS);
    // The one human chat in the database on the window side of the switch.
    expect(hers?.whole).toBe(false);
    // 46 messages apart, and 27 minutes: the two measures the window ORs.
    expect(DIET - DOCTORS).toBe(46);
    expect(minutesApart(DOCTORS, DIET)).toBeCloseTo(26.8, 1);
    expect(DIET - COLD).toBe(141);
    expect(minutesApart(COLD, DIET)).toBeGreaterThan(45);
  });
});

describe("the repro: 'how is pranjali's health'", () => {
  it("the retrieval this replaced returns the diet and none of the rest", () => {
    const block = legacyBlock(QUERY);

    // The marketing broadcast, the diet line, and six other people saying
    // "how come" — which is the measured shape of it.
    expect(block).toContain("Ragi dosa aaj bhi");
    expect(block).toContain("Orange Health: full body health checkup");
    for (const line of CLINICAL) expect(block, line).not.toContain(line);

    // Unbounded, exactly one of the six is reachable at all, and only because
    // it happens to contain the function word `is` — at rank 49, behind fifty
    // rows of other people using the same word to say nothing.
    const everything = legacyBlock(QUERY, 500).split("\n");
    const reachable = CLINICAL.filter((line) => everything.some((r) => r.includes(line)));
    expect(reachable).toEqual(["Throat is bad, shall start antibiotics today"]);
    expect(everything.findIndex((r) => r.includes(reachable[0]))).toBeGreaterThan(40);
  });

  it("surfaces the cold, the medicines and the doctors", async () => {
    const seeds = await semanticSeeds();
    const { block } = await buildGroundedContext(QUERY, { now: NOW });

    for (const line of CLINICAL) expect(block, line).toContain(line);
    expect(seeds.length).toBeGreaterThan(0);
  });

  it("reaches all six with no encoder at all, on the within-chat pass alone", async () => {
    forgetEmbedder();
    resetSemanticCacheForTests();
    // A brand-new install: no vectors, nothing switched on, nothing to await.
    const { block, result } = await buildGroundedContext(QUERY, { now: NOW });
    expect(result.semanticSeedIds).toEqual([]);
    for (const line of CLINICAL) expect(block, line).toContain(line);
  });

  it("cannot reach the cold without the within-chat pass, whatever the window does", () => {
    // The two modes that existed before it. "Exhaustion and cold" is 141
    // messages and a day from the only lexical hit and shares no token with the
    // question, so ±8 messages / ±45 minutes cannot reach it — and her chat is
    // far too big to hand over whole instead. That is the gap, as a
    // measurement: neither mode fails by a little.
    const windowed = retrieveContext({ query: QUERY, now: NOW, focusSeedLimit: 0 });
    expect(formatContextBlock(windowed)).not.toContain("Exhaustion and cold");
    expect(windowed.sections.find((s) => s.channelId === CH_PRANJALI)?.whole).toBe(false);
  });
});

describe("the within-chat pass", () => {
  it("searches her whole history for what the question MEANT", () => {
    const { match, expanded } = focusMatch(planQuery(QUERY, NOW));
    // Four languages, because her chat is written in four.
    for (const word of ["cold", "meds", "doctor", "tabiyat", "dawai", "bimar"]) {
      expect(expanded, word).toContain(word);
    }
    expect(match).toContain('"health"');

    const hits = focusSearch({ channelIds: [CH_PRANJALI], plan: planQuery(QUERY, NOW) });
    const found = hits.hits.map((h) => h.text);
    for (const line of CLINICAL) expect(found, line).toContain(line);
  });

  it("only runs on a chat a name SELECTED, and only there", () => {
    // No name, no pool: expansion corpus-wide would return the broadcast, the
    // shorts and every pharmacy in the database on any health question.
    const anonymous = retrieveContext({ query: "health", now: NOW });
    expect(anonymous.focus.channelIds).toEqual([]);
    expect(anonymous.focus.hitIds).toEqual([]);

    const named = retrieveContext({ query: QUERY, now: NOW });
    expect(named.focus.channelIds).toEqual([CH_PRANJALI]);
    expect(named.focus.hitIds.length).toBeGreaterThan(0);
    // The broadcast shares the topic word and is not a chat anyone named.
    expect(named.focus.channelIds).not.toContain(CH_ORANGE);
  });

  it("does not let a within-chat rank reorder the corpus-wide one", () => {
    // The two searches are different queries over different pools; their bm25
    // numbers are not on one scale. The chats the block is about are still
    // decided by the corpus-wide pass alone.
    const withFocus = retrieveContext({ query: QUERY, now: NOW });
    const without = retrieveContext({ query: QUERY, now: NOW, focusSeedLimit: 0 });
    expect(withFocus.sections.map((s) => s.channelId)).toEqual(
      expect.arrayContaining(without.sections.map((s) => s.channelId)),
    );
  });
});

describe("lever 1 — a name selects the chat", () => {
  it("takes the name out of the possessive before looking it up", () => {
    const plan = planQuery(QUERY, NOW);
    // sanitize() eats the apostrophe, and `pranjalis` is nobody.
    expect(plan.terms).toEqual(["pranjalis", "health"]);
    expect(plan.names).toContain("pranjali");
  });

  it("resolves her chat and refuses the broadcast that shares the topic word", () => {
    const named = resolveChannelsByName(planQuery(QUERY, NOW).names);
    expect(named[0]).toMatchObject({ channelId: CH_PRANJALI, exact: true });

    const result = retrieveContext({ query: QUERY, now: NOW });
    const boosted = new Set(
      result.ranked.filter((r) => r.hit.channelBoosted).map((r) => r.hit.channelId),
    );
    expect(boosted).toContain(CH_PRANJALI);
    // "Orange Health Updates" carries `health` as one word of a title. It is
    // still findable — it just does not get to be the chat the question named.
    expect(boosted).not.toContain(CH_ORANGE);
  });

  it("puts her chat first even though the broadcast outscores every row in it", async () => {
    const semanticSeeds_ = await semanticSeeds();
    const opts = { now: NOW, semanticSeeds: semanticSeeds_ };

    // Measured with the within-chat pass off, which is the only way to see the
    // mechanism: with it on her chat now has the strongest rows in the database
    // and would lead on score too, which would prove nothing about the ordering.
    const withNames = retrieveContext({ query: QUERY, ...opts, focusSeedLimit: 0 });
    expect(withNames.sections[0].channelId).toBe(CH_PRANJALI);
    // Not on score: "Orange Health: full body health checkup" says the word
    // three times and was sent this morning, so it wins the blend outright.
    expect(withNames.sections[0].score).toBeLessThan(withNames.sections[1].score);

    const withoutNames = retrieveContext({
      query: QUERY,
      ...opts,
      focusSeedLimit: 0,
      resolveNames: false,
    });
    expect(withoutNames.sections[0].channelId).toBe(CH_ORANGE);

    // Whatever the scores say, the chat the question named is still first.
    expect(retrieveContext({ query: QUERY, ...opts }).sections[0].channelId).toBe(
      CH_PRANJALI,
    );

    forgetEmbedder();
    resetSemanticCacheForTests();
  });
});

describe("lever 2 — the window follows the clock, not the message count", () => {
  it("±8 messages cannot reach the doctors; ±45 minutes sweeps all of them", () => {
    // Measured with the within-chat pass off: it reaches the cluster directly,
    // which would hide whether the window still does its own job.
    const opts = { query: QUERY, now: NOW, focusSeedLimit: 0 };
    const narrow = formatContextBlock(retrieveContext({ ...opts, windowMinutes: 0 }));
    expect(narrow).not.toContain("Doctor ko dikhaya");

    const wide = formatContextBlock(retrieveContext(opts));
    expect(wide).toContain("Doctor ko dikhaya");
    expect(wide).toContain("2 doctors kar toh rahe hai supervise virtually");
  });
});

describe("lever 3 — a section spends its own share", () => {
  it("her chat gets the block, not the shorts and the broadcast", () => {
    const block = formatContextBlock(retrieveContext({ query: QUERY, now: NOW }));
    const lines = block.split("\n").filter((l) => /^[* ] \[evt /.test(l));
    const hers = lines.filter((l) => l.includes("[evt 3A"));
    expect(hers.length / lines.length).toBeGreaterThan(0.8);
    // The broadcast is still there. It is a footnote instead of half the block.
    const broadcast = lines.filter((l) => l.includes("[evt 3C"));
    expect(broadcast.length).toBeLessThanOrEqual(3);
  });

  it("gives up the far edge of the window before the cluster it was widened to reach", () => {
    // Window behaviour, so the within-chat pass is off: the rows it adds are
    // hits, and hits are never what the budget gives up.
    const result = retrieveContext({ query: QUERY, now: NOW, focusSeedLimit: 0 });
    const full = formatContextBlock(result);
    // Seven per cent short of what it wants, so a handful of lines have to go.
    const squeezed = formatContextBlock(result, {
      maxChars: Math.round(full.length * 0.93),
    });

    // 46 messages from the hit but 27 minutes: the same conversation, and the
    // reason the window has a clock at all.
    expect(squeezed).toContain("Doctor ko dikhaya");
    // 59 messages and 34 minutes: further out by both, so it goes first.
    expect(squeezed).not.toContain(`[evt ${stanza("A", 141)}]`);
  });

  it("stops calling a section the whole chat once it has been trimmed", () => {
    const result = retrieveContext({ query: QUERY, now: NOW });
    // Rashmi's chat is small enough to arrive whole, and says so.
    expect(formatContextBlock(result)).toContain("— the whole chat");
    // Starved, it is no longer whole — and a model told it has the whole chat
    // has no reason to ask for the rest.
    expect(formatContextBlock(result, { maxChars: 900 })).not.toContain(
      "— the whole chat",
    );
  });
});

describe("lever 4 — a scraped page is not a seed", () => {
  it("finds the shorts and refuses to expand a conversation around them", () => {
    const result = retrieveContext({ query: QUERY, now: NOW });
    const scraped = result.ranked.filter(
      (r) => r.hit.matchedColumn === "link_scraped_text",
    );
    expect(scraped.length).toBeGreaterThan(0);
    expect(result.sections.map((s) => s.channelId)).not.toContain(CH_GHAR);
  });

  it("still answers a question whose only evidence IS a page", () => {
    const result = retrieveContext({ query: "2bhk tour", now: NOW });
    expect(result.sections.map((s) => s.channelId)).toContain(CH_GHAR);
  });
});

describe("lever 5 — the id is what it costs", () => {
  it("prints the stanza, not the chat jid on every line", () => {
    const block = formatContextBlock(retrieveContext({ query: QUERY, now: NOW }));
    expect(block).toContain(`[evt ${stanza("A", DIET)}]`);
    expect(shortEventId(`wa:919000000021@s.whatsapp.net/${stanza("A", DIET)}`)).toBe(
      stanza("A", DIET),
    );
    expect(block).not.toContain("[evt wa:919000000021@s.whatsapp.net/");
  });

  it("is worth about a third of the block on a section this size", () => {
    const block = formatContextBlock(retrieveContext({ query: QUERY, now: NOW }));
    const lines = block.split("\n").filter((l) => /^[* ] \[evt /.test(l));
    // 51 chars against 4: what the whole id would have cost, minus what the
    // stanza does.
    const saved = lines.length * ("wa:919000000021@s.whatsapp.net/".length);
    expect(saved).toBeGreaterThan(block.length * 0.25);
  });
});

describe("lever 6 — meaning, when there is an index to read it from", () => {
  it("reaches the cold from the word health, sharing no token with it", async () => {
    const seeds = await semanticSeeds();
    const ids = seeds.map((s) => s.eventId);
    expect(ids).toContain(`wa:919000000021@s.whatsapp.net/${stanza("A", COLD)}`);

    const withSemantic = retrieveContext({
      query: QUERY,
      now: NOW,
      semanticSeeds: seeds,
    });
    expect(formatContextBlock(withSemantic)).toContain("Exhaustion and cold");
  });

  it("stays quiet on a half-built index rather than answering from a tenth of it", async () => {
    setEmbedder(conceptEmbedder);
    getDb().prepare(`DELETE FROM event_embeddings`).run();
    resetSemanticCacheForTests();

    // One background batch in. e5 scores every message in a real corpus
    // 0.76–0.85 against any question, so an uncalibrated index says yes to all
    // of them — six confident seeds, for anything.
    await indexSemanticBatch(32);
    resetSemanticCacheForTests();
    expect(await semanticSearch(QUERY)).toEqual([]);

    await indexSemanticBatch(1000);
    resetSemanticCacheForTests();
    expect((await semanticSearch(QUERY)).length).toBeGreaterThan(0);
  });

  it("degrades silently with no encoder at all — the state it ships in", async () => {
    forgetEmbedder();
    resetSemanticCacheForTests();
    expect(await semanticSearch(QUERY)).toEqual([]);

    const lexical = retrieveContext({ query: QUERY, now: NOW });
    const asked = await buildGroundedContext(QUERY, { now: NOW });
    expect(asked.block).toBe(formatContextBlock(lexical));
  });
});
