// ===========================================================================
// Retrieval primitives (vitest). The fixture is the repro from docs/v6-spec.md
// §1, rebuilt: a chat where the answer to "anything planned on sunday" shares
// no token with the question, sits eight messages later, and quotes the message
// that asked. Each test pins the primitive that reaches it.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import {
  appStateSet,
  selfIdentityKey,
  insertEvent,
  recordLinkScrape,
  recordMediaDescription,
  recordTranscript,
  upsertActor,
  upsertStream,
  upsertSource,
} from "./ingest.js";
import {
  DEFAULT_CHANNEL_BOOST,
  DEFAULT_WHOLE_CHANNEL_MAX_CHARS,
  DEFAULT_WINDOW_MAX_ROWS,
  EVENTS_FTS_COLUMNS,
  readChannelWindow,
  readEventsByIds,
  readReplyChain,
  readChannelEventIds,
  readWholeChannel,
  resolveChannelsByName,
  searchChannelRanked,
  searchEventsRanked,
} from "./retrieval.js";
import { renderEventBody } from "../retrieval/format.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-retrieval-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "supertwinv13.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const SELF_JID = "me@s.whatsapp.net";

interface SeedEvent {
  externalId: string;
  text: string;
  minute: number;
  self?: boolean;
  kind?: string;
  replyToExternalId?: string;
  replyToText?: string;
  mediaPath?: string;
}

/** The "Weekend lunches" chat, message for message from the spec's repro. */
const WEEKEND_LUNCHES: SeedEvent[] = [
  { externalId: "m01", text: "sunday lunch chalna hai kahin?", minute: 1 },
  { externalId: "m02", text: "Can do. Place?", minute: 2, self: true, replyToExternalId: "m01", replyToText: "sunday lunch chalna hai kahin?" },
  { externalId: "m03", text: "let's give kalpaney another try?", minute: 3 },
  { externalId: "m04", text: "nah", minute: 4, self: true },
  { externalId: "m05", text: "too far", minute: 5, self: true },
  { externalId: "m06", text: "Let's go to New place!", minute: 6 },
  { externalId: "m07", text: "ok", minute: 7, self: true },
  { externalId: "m08", text: "kitne baje", minute: 8, self: true },
  // The answer, eight messages after the question and sharing no word with it.
  { externalId: "m09", text: "booked oye kake", minute: 9, replyToExternalId: "m01", replyToText: "sunday lunch chalna hai kahin?" },
  { externalId: "m10", text: "🎉", minute: 10, kind: "reaction", replyToExternalId: "m09" },
];

function seedWeekendLunches(): { streamId: string } {
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  const streamId = upsertStream({
    sourceId: "whatsapp",
    sourceExtId: "lunches@g.us",
    name: "Weekend lunches",
    kind: "group",
  });
  const them = upsertActor({
    sourceId: "whatsapp",
    sourceExtId: "friend@s.whatsapp.net",
    displayName: "Rahul",
  });
  const me = upsertActor({
    sourceId: "whatsapp",
    sourceExtId: SELF_JID,
    displayName: "Me",
    isSelf: true,
  });
  appStateSet(selfIdentityKey("whatsapp"), SELF_JID);

  for (const e of WEEKEND_LUNCHES) {
    insertEvent({
      externalId: e.externalId,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: e.self ? me : them,
      ts: `2026-08-01T12:${String(e.minute).padStart(2, "0")}:00.000Z`,
      kind: e.kind ?? "message",
      text: e.text,
      mediaPath: e.mediaPath ?? null,
      rawJson: null,
      replyToExternalId: e.replyToExternalId ?? null,
      replyToText: e.replyToText ?? null,
    });
  }
  return { streamId };
}

/** The window as it was before the time span: counts alone. */
const COUNT_ONLY = { beforeMinutes: 0, afterMinutes: 0 } as const;

/** `count` messages `everyMs` apart, so a chat can be made dense or sparse. */
function seedBurst(
  streamId: string,
  prefix: string,
  count: number,
  startTs: string,
  everyMs: number,
): void {
  const width = Math.max(2, String(count).length);
  const start = Date.parse(startTs);
  for (let i = 0; i < count; i++) {
    const n = String(i + 1).padStart(width, "0");
    insertEvent({
      externalId: `${prefix}${n}`,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: new Date(start + i * everyMs).toISOString(),
      kind: "message",
      text: `line ${n}`,
      mediaPath: null,
      rawJson: null,
    });
  }
}

describe("searchEventsRanked", () => {
  it("keeps the FTS column list in step with the migration", () => {
    seedWeekendLunches();
    const cols = (
      getDb().prepare(`PRAGMA table_info(events_fts)`).all() as { name: string }[]
    ).map((c) => c.name);
    // bm25 weights are positional and snippet() takes an index, so a column
    // added to the table without being added here silently mis-weights.
    expect(cols).toEqual([...EVENTS_FTS_COLUMNS]);
  });

  it("returns hits best-first with the message text ranked over a scraped page", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "page",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T11:00:00.000Z",
      kind: "message",
      text: "https://example.com/guide",
      mediaPath: null,
      rawJson: null,
      linkUrl: "https://example.com/guide",
    });
    recordLinkScrape("whatsapp:page", {
      // The failure mode from §1: a long page carries every query word.
      scrapedText: `${"a lunch guide for sunday afternoons. ".repeat(60)}`,
      status: "done",
    });

    const hits = searchEventsRanked({ match: `"sunday" OR "lunch"` });
    expect(hits[0].id).toBe("whatsapp:m01");
    expect(hits[0].matchedColumn).toBe("text");
    expect(hits.map((h) => h.id)).toContain("whatsapp:page");
    // Best-first, and SQLite's bm25 counts down: the page must not lead.
    expect(hits[0].score).toBeLessThan(hits[hits.length - 1].score);
    expect(hits.findIndex((h) => h.id === "whatsapp:page")).toBeGreaterThan(0);
  });

  it("lets the caller re-weight the columns", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "voice",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T11:30:00.000Z",
      kind: "audio",
      text: "",
      mediaPath: "/media/wa/v.ogg",
      rawJson: null,
    });
    recordTranscript("whatsapp:voice", { transcript: "sunday lunch", status: "done" });

    const byText = searchEventsRanked({ match: `"sunday" OR "lunch"` });
    expect(byText[0].id).toBe("whatsapp:m01");

    const byVoice = searchEventsRanked({
      match: `"sunday" OR "lunch"`,
      weights: { text: 0.1, transcript: 10 },
    });
    expect(byVoice[0].id).toBe("whatsapp:voice");
  });

  it("snippets the column that matched, not column 0", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "voice",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T11:30:00.000Z",
      kind: "audio",
      // A voice note has no message text at all — snippetting column 0 for it
      // is what put a blank line in the prompt (§1).
      text: "",
      mediaPath: "/media/wa/v.ogg",
      rawJson: null,
    });
    recordTranscript("whatsapp:voice", {
      transcript: "table booked for sunday, one o'clock",
      status: "done",
    });

    const hit = searchEventsRanked({ match: `"booked"` }).find(
      (h) => h.id === "whatsapp:voice",
    )!;
    expect(hit.matchedColumn).toBe("transcript");
    expect(hit.matchedColumnIndex).toBe(EVENTS_FTS_COLUMNS.indexOf("transcript"));
    expect(hit.snippet).toContain("booked");
    expect(hit.snippet.trim()).not.toBe("");
  });

  it("names the description column for a hit that lives in an attachment", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "photo",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T11:45:00.000Z",
      kind: "image",
      text: "",
      mediaPath: "/media/wa/p.jpg",
      rawJson: null,
    });
    recordMediaDescription("whatsapp:photo", {
      description: "a restaurant bill from kalpaney",
      status: "done",
    });

    const hit = searchEventsRanked({ match: `"restaurant"` })[0];
    expect(hit.id).toBe("whatsapp:photo");
    expect(hit.matchedColumn).toBe("media_description");
    expect(hit.snippet).toContain("restaurant");
  });

  it("reaches a reply through the text it quotes", () => {
    seedWeekendLunches();
    const hits = searchEventsRanked({ match: `"chalna"` });
    const reply = hits.find((h) => h.id === "whatsapp:m02")!;
    expect(reply.matchedColumn).toBe("reply_to_text");
    expect(reply.snippet).toContain("chalna");
    // The original still outranks the copy of it.
    expect(hits[0].id).toBe("whatsapp:m01");
  });

  it("never returns a reaction, and returns nothing for an empty match", () => {
    seedWeekendLunches();
    expect(searchEventsRanked({ match: `"🎉"` }).map((h) => h.id)).not.toContain(
      "whatsapp:m10",
    );
    expect(searchEventsRanked({ match: "   " })).toEqual([]);
  });

  it("throws on an FTS expression it cannot parse", () => {
    seedWeekendLunches();
    // Deliberate: the caller taking free text from a user is the one that knows
    // how it wants to degrade.
    expect(() => searchEventsRanked({ match: `"unclosed` })).toThrow();
  });

  it("carries the sender, chat and self flag on every hit", () => {
    seedWeekendLunches();
    const hit = searchEventsRanked({ match: `"kahin"` })[0];
    expect(hit.actorName).toBe("Rahul");
    expect(hit.channelName).toBe("Weekend lunches");
    expect(hit.fromMe).toBe(false);

    const mine = searchEventsRanked({ match: `"Place"` }).find(
      (h) => h.id === "whatsapp:m02",
    )!;
    expect(mine.fromMe).toBe(true);
  });
});

describe("readEventsByIds", () => {
  it("returns rows in the order asked for, skipping ids it does not have", () => {
    seedWeekendLunches();
    // The order a vector search hands back — the one thing the row cannot say.
    const rows = readEventsByIds(["whatsapp:m09", "whatsapp:nope", "whatsapp:m01", "whatsapp:m09"]);
    expect(rows.map((r) => r.id)).toEqual(["whatsapp:m09", "whatsapp:m01"]);
    expect(rows[0].text).toBe("booked oye kake");
    expect(rows[0].channelName).toBe("Weekend lunches");
    expect(readEventsByIds([])).toEqual([]);
  });
});

describe("readChannelWindow", () => {
  it("recovers the answer eight messages after the hit", () => {
    seedWeekendLunches();
    const hit = searchEventsRanked({ match: `"sunday" OR "planned"` })[0];
    expect(hit.id).toBe("whatsapp:m01");

    const ids = readChannelWindow({ eventId: hit.id }).map((r) => r.id);
    // ±8 was measured to recover 100% of what ranking left out (§1). All three
    // of these match zero query tokens.
    expect(ids).toContain("whatsapp:m09");
    expect(ids).toContain("whatsapp:m03");
    expect(ids).toContain("whatsapp:m06");
    expect(ids).toContain("whatsapp:m01");
  });

  it("returns the window oldest-first, anchor included, reactions left out", () => {
    seedWeekendLunches();
    const rows = readChannelWindow({
      eventId: "whatsapp:m05",
      before: 2,
      after: 2,
      ...COUNT_ONLY,
    });
    expect(rows.map((r) => r.id)).toEqual([
      "whatsapp:m03",
      "whatsapp:m04",
      "whatsapp:m05",
      "whatsapp:m06",
      "whatsapp:m07",
    ]);
    expect(rows.map((r) => r.id)).not.toContain("whatsapp:m10");
  });

  it("takes the NEAREST neighbours when the chat is longer than the window", () => {
    seedWeekendLunches();
    const rows = readChannelWindow({
      eventId: "whatsapp:m05",
      before: 1,
      after: 1,
      ...COUNT_ONLY,
    });
    expect(rows.map((r) => r.id)).toEqual(["whatsapp:m04", "whatsapp:m05", "whatsapp:m06"]);
  });

  it("supports a one-sided window and an unknown event", () => {
    seedWeekendLunches();
    expect(
      readChannelWindow({ eventId: "whatsapp:m05", before: 0, after: 2, ...COUNT_ONLY }).map(
        (r) => r.id,
      ),
    ).toEqual(["whatsapp:m05", "whatsapp:m06", "whatsapp:m07"]);
    expect(readChannelWindow({ eventId: "whatsapp:nope" })).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // v7 §6, lever 2. DEFAULT_WINDOW was tuned on a sparse chat; on a dense one
  // ±8 messages is about five minutes, and the cluster that answers the
  // question sits 46 messages but 27 minutes away.
  // -------------------------------------------------------------------------

  it("sweeps a dense cluster the message count stops short of", () => {
    const { streamId } = seedWeekendLunches();
    // 46 messages after the hit, all inside half an hour — the measured shape.
    seedBurst(streamId, "d", 46, "2026-08-01T12:09:30.000Z", 35_000);

    const counted = readChannelWindow({ eventId: "whatsapp:m09", ...COUNT_ONLY }).map(
      (r) => r.id,
    );
    expect(counted).not.toContain("whatsapp:d46");

    const ids = readChannelWindow({ eventId: "whatsapp:m09" }).map((r) => r.id);
    expect(ids).toContain("whatsapp:d46");
    expect(ids).toContain("whatsapp:d01");
    // Still one contiguous run around the anchor, oldest first.
    expect(ids.filter((id) => id === "whatsapp:m09")).toHaveLength(1);
    expect(ids.indexOf("whatsapp:m09")).toBeLessThan(ids.indexOf("whatsapp:d01"));
  });

  it("is the UNION of the two: the count reaches past a quiet span", () => {
    const { streamId } = seedWeekendLunches();
    // Two days later — outside any span, well inside ±8 messages.
    seedBurst(streamId, "far", 2, "2026-08-03T12:00:00.000Z", 60_000);

    const ids = readChannelWindow({ eventId: "whatsapp:m09" }).map((r) => r.id);
    expect(ids).toContain("whatsapp:far01");
    expect(ids).toContain("whatsapp:m01");
  });

  it("holds the span to its cap, nearest first", () => {
    const { streamId } = seedWeekendLunches();
    seedBurst(streamId, "d", 200, "2026-08-01T12:09:30.000Z", 1_000);

    const after = readChannelWindow({ eventId: "whatsapp:m09" }).filter((r) =>
      r.id.startsWith("whatsapp:d"),
    );
    expect(after).toHaveLength(DEFAULT_WINDOW_MAX_ROWS);
    expect(after[0].id).toBe("whatsapp:d001");
  });

  it("keeps a side asked for nothing empty, whatever the span says", () => {
    seedWeekendLunches();
    // What pages a chat one direction at a time: a span must not reach back.
    const rows = readChannelWindow({ eventId: "whatsapp:m05", before: 0, after: 2 });
    expect(rows.map((r) => r.id)).toEqual(["whatsapp:m05", "whatsapp:m06", "whatsapp:m07", "whatsapp:m08", "whatsapp:m09"]);
    expect(rows.map((r) => r.id)).not.toContain("whatsapp:m04");
  });
});

describe("readReplyChain", () => {
  it("walks both directions and orders the thread by time", () => {
    seedWeekendLunches();
    const chain = readReplyChain({ eventId: "whatsapp:m02" });
    // Up to what m02 quotes, down to the other reply to that same message.
    expect(chain.map((r) => r.id)).toEqual(["whatsapp:m01", "whatsapp:m02"]);

    const fromRoot = readReplyChain({ eventId: "whatsapp:m01" });
    expect(fromRoot.map((r) => r.id)).toEqual(["whatsapp:m01", "whatsapp:m02", "whatsapp:m09"]);
    expect(fromRoot.map((r) => r.depth)).toEqual([0, 1, 1]);
  });

  it("marks quoted ancestors with a negative depth", () => {
    seedWeekendLunches();
    const chain = readReplyChain({ eventId: "whatsapp:m09" });
    expect(chain.find((r) => r.id === "whatsapp:m01")!.depth).toBe(-1);
    expect(chain.find((r) => r.id === "whatsapp:m09")!.depth).toBe(0);
  });

  it("follows more than one hop and stops at maxDepth", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "m12",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T12:12:00.000Z",
      kind: "message",
      text: "which place tho",
      mediaPath: null,
      rawJson: null,
      replyToExternalId: "m09",
      replyToText: "booked oye kake",
    });

    expect(readReplyChain({ eventId: "whatsapp:m12" }).map((r) => r.id)).toEqual([
      "whatsapp:m01",
      "whatsapp:m09",
      "whatsapp:m12",
    ]);
    expect(
      readReplyChain({ eventId: "whatsapp:m12", maxDepth: 1 }).map((r) => r.id),
    ).toEqual(["whatsapp:m09", "whatsapp:m12"]);
  });

  it("skips reactions on the way down and survives a self-referencing edge", () => {
    const { streamId } = seedWeekendLunches();
    // A reaction quotes its target too; a thread of emoji is not a thread.
    expect(readReplyChain({ eventId: "whatsapp:m09" }).map((r) => r.id)).not.toContain(
      "whatsapp:m10",
    );

    insertEvent({
      externalId: "loop",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T12:20:00.000Z",
      kind: "message",
      text: "quoting myself",
      mediaPath: null,
      rawJson: null,
      replyToExternalId: "loop",
      replyToText: "quoting myself",
    });
    expect(readReplyChain({ eventId: "whatsapp:loop" }).map((r) => r.id)).toEqual([
      "whatsapp:loop",
    ]);
  });

  it("returns nothing for an unknown event", () => {
    seedWeekendLunches();
    expect(readReplyChain({ eventId: "whatsapp:nope" })).toEqual([]);
  });
});

describe("readWholeChannel", () => {
  it("includes a small chat whole, oldest-first, reactions excluded", () => {
    const { streamId } = seedWeekendLunches();
    const read = readWholeChannel({ channelId: streamId });

    expect(read.withinBudget).toBe(true);
    expect(read.channelName).toBe("Weekend lunches");
    expect(read.eventCount).toBe(WEEKEND_LUNCHES.length - 1);
    expect(read.events).toHaveLength(read.eventCount);
    expect(read.events[0].id).toBe("whatsapp:m01");
    expect(read.events.at(-1)!.id).toBe("whatsapp:m09");
    // The whole repro chat is far under the budget the failing retrieval was
    // already spending (§1).
    expect(read.charCount).toBeLessThan(DEFAULT_WHOLE_CHANNEL_MAX_CHARS / 4);
  });

  it("counts the text a caller would actually inject", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "voice",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T12:30:00.000Z",
      kind: "audio",
      text: "",
      mediaPath: "/media/wa/v.ogg",
      rawJson: null,
    });
    const before = readWholeChannel({ channelId: streamId }).charCount;
    recordTranscript("whatsapp:voice", { transcript: "table booked", status: "done" });
    expect(readWholeChannel({ channelId: streamId }).charCount).toBe(
      before + "table booked".length,
    );
  });

  it("reports the size but reads nothing when the chat is over budget", () => {
    const { streamId } = seedWeekendLunches();
    const read = readWholeChannel({ channelId: streamId, maxChars: 10 });

    expect(read.withinBudget).toBe(false);
    expect(read.events).toEqual([]);
    expect(read.eventCount).toBe(WEEKEND_LUNCHES.length - 1);
    expect(read.charCount).toBeGreaterThan(10);

    expect(readWholeChannel({ channelId: streamId, maxEvents: 3 }).withinBudget).toBe(false);
  });

  it("treats an unknown or empty channel as nothing to include", () => {
    seedWeekendLunches();
    const read = readWholeChannel({ channelId: "whatsapp:st:nope" });
    expect(read).toMatchObject({
      channelName: null,
      eventCount: 0,
      charCount: 0,
      renderedCharCount: 0,
      withinBudget: false,
      events: [],
    });
  });

  // -------------------------------------------------------------------------
  // v7 §6, lever 5. The chat that had to stay out is 231 events / 8,992
  // retrievable chars, which renders to 32,666 — deciding on the smaller number
  // is how the wrong chat gets injected whole.
  // -------------------------------------------------------------------------

  it("costs the chat in the chars the block will carry, not the chars stored", () => {
    const { streamId } = seedWeekendLunches();
    const read = readWholeChannel({ channelId: streamId });

    // The id, the time, the sender and the brackets are on every line.
    expect(read.renderedCharCount).toBeGreaterThan(read.charCount * 2);
  });

  it("agrees with the renderer itself, line for line", () => {
    const { streamId } = seedWeekendLunches();
    insertEvent({
      externalId: "rich",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: "2026-08-01T12:30:00.000Z",
      kind: "image",
      text: "look",
      mediaPath: "/media/wa/a.jpg",
      rawJson: null,
      replyToExternalId: "m01",
      replyToText: "sunday lunch chalna hai kahin?",
      linkUrl: "https://example.com/menu",
      linkTitle: "The menu",
      linkDescription: "everything they serve",
    });
    recordMediaDescription("whatsapp:rich", {
      description: "a whiteboard covered in arrows",
      status: "done",
    });
    recordTranscript("whatsapp:rich", { transcript: "ferry pakadni hai", status: "done" });

    // The estimate lives here and the rendering lives in retrieval/format.ts;
    // this is what stops the two drifting. It may only ever guess HIGH — a
    // budget that guesses low blows the block it exists to protect — and it is
    // within 2% over a chat carrying every part a line can have.
    const read = readWholeChannel({ channelId: streamId });
    const actual = read.events.reduce(
      (n, row) => n + renderEventBody(row).length + 2 + 1,
      0,
    );
    expect(read.renderedCharCount).toBeGreaterThanOrEqual(actual);
    expect(read.renderedCharCount).toBeLessThan(actual * 1.02);
  });

  it("caps a runaway field the way the renderer does", () => {
    const { streamId } = seedWeekendLunches();
    const long = readWholeChannel({ channelId: streamId }).renderedCharCount;
    recordLinkScrape("whatsapp:m09", { scrapedText: "x".repeat(40_000), status: "done" });
    // A scraped page is never rendered at all, so it costs the budget nothing.
    expect(readWholeChannel({ channelId: streamId }).renderedCharCount).toBe(long);

    recordTranscript("whatsapp:m09", { transcript: "y".repeat(40_000), status: "done" });
    const withTranscript = readWholeChannel({ channelId: streamId }).renderedCharCount;
    expect(withTranscript - long).toBeLessThan(500);
    // The retrievable count still reports the whole 40 KB, which is the gap.
    expect(readWholeChannel({ channelId: streamId }).charCount).toBeGreaterThan(40_000);
  });

  it("spends the budget on the rendered number", () => {
    const { streamId } = seedWeekendLunches();
    const read = readWholeChannel({ channelId: streamId });

    expect(readWholeChannel({ channelId: streamId, maxChars: read.charCount }).withinBudget).toBe(
      false,
    );
    expect(
      readWholeChannel({ channelId: streamId, maxChars: read.renderedCharCount }).withinBudget,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// v7 §6, lever 1. Retrieval had no concept of WHO: channel_name and
// actor_display_name are not FTS columns, so a name in the question was a token
// that matched almost nothing anywhere.
// ---------------------------------------------------------------------------

describe("resolveChannelsByName", () => {
  /** A second chat, so a name has something to pick BETWEEN. */
  function seedSecondChat(): { streamId: string; actorId: string } {
    const streamId = upsertStream({
      sourceId: "whatsapp",
      sourceExtId: "pranjali@s.whatsapp.net",
      name: "Pranjali",
      kind: "dm",
    });
    const actorId = upsertActor({
      sourceId: "whatsapp",
      sourceExtId: "pranjali@s.whatsapp.net",
      displayName: "Pranjali",
    });
    insertEvent({
      externalId: "p01",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId,
      ts: "2026-08-01T09:00:00.000Z",
      kind: "message",
      text: "doctor ne bola rest karo",
      mediaPath: null,
      rawJson: null,
    });
    return { streamId, actorId };
  }

  it("selects the chat a name belongs to", () => {
    seedWeekendLunches();
    const { streamId } = seedSecondChat();

    const matches = resolveChannelsByName(["pranjali", "health"]);
    expect(matches[0]).toMatchObject({
      channelId: streamId,
      channelName: "Pranjali",
      token: "pranjali",
      exact: true,
    });
    // "health" names nobody; a topic word must not select a conversation.
    expect(matches.every((m) => m.token === "pranjali")).toBe(true);
  });

  it("finds the chat through the person who speaks in it", () => {
    const { streamId } = seedWeekendLunches();

    const matches = resolveChannelsByName(["rahul"]);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      channelId: streamId,
      via: "actor",
      actorName: "Rahul",
      exact: true,
      // What backs it: the messages that person sent in that chat, the emoji
      // they reacted with excluded.
      eventCount: 4,
    });
  });

  it("matches a whole word, never a fragment", () => {
    seedWeekendLunches();
    upsertStream({
      sourceId: "whatsapp",
      sourceExtId: "fam@g.us",
      name: "Bharadwaj family ❤️",
      kind: "group",
    });

    expect(resolveChannelsByName(["raj"])).toEqual([]);
    expect(resolveChannelsByName(["Bharadwaj"]).map((m) => m.channelName)).toEqual([
      "Bharadwaj family ❤️",
    ]);
    // Punctuation the query drags along is not part of the name.
    expect(resolveChannelsByName(["'Rahul',"]).map((m) => m.actorName)).toEqual([
      "Rahul",
    ]);
  });

  it("ignores tokens too short to be a name, and unknown names", () => {
    seedWeekendLunches();
    expect(resolveChannelsByName(["ok", "hi", ""])).toEqual([]);
    expect(resolveChannelsByName(["nobodyhere"])).toEqual([]);
    expect(resolveChannelsByName([])).toEqual([]);
  });

  it("ranks an exact name over a chat that merely contains it", () => {
    seedWeekendLunches();
    seedSecondChat();
    upsertStream({
      sourceId: "whatsapp",
      sourceExtId: "trip@g.us",
      name: "Pranjali and the goa crew",
      kind: "group",
    });

    const matches = resolveChannelsByName(["pranjali"]);
    expect(matches[0].channelName).toBe("Pranjali");
    expect(matches.map((m) => m.channelName)).toContain("Pranjali and the goa crew");
    // Named but empty: nothing to say, so it sorts under the chat that has.
    expect(matches.at(-1)!.eventCount).toBe(0);
  });
});

describe("searchEventsRanked channel boost", () => {
  it("puts a named chat's rows ahead of an equal hit somewhere else", () => {
    const { streamId } = seedWeekendLunches();
    const other = upsertStream({
      sourceId: "whatsapp",
      sourceExtId: "shorts@g.us",
      name: "Shorts",
      kind: "group",
    });
    insertEvent({
      externalId: "s01",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: other,
      actorId: null,
      ts: "2026-08-01T12:20:00.000Z",
      kind: "message",
      text: "booked oye kake",
      mediaPath: null,
      rawJson: null,
    });

    // The same words in both chats: without the boost the newer one can lead.
    const plain = searchEventsRanked({ match: `"booked"` });
    expect(plain.every((h) => h.channelBoosted === false)).toBe(true);

    const boosted = searchEventsRanked({
      match: `"booked"`,
      boostChannelIds: [streamId],
    });
    expect(boosted[0].id).toBe("whatsapp:m09");
    expect(boosted[0].channelBoosted).toBe(true);
    expect(boosted.find((h) => h.id === "whatsapp:s01")!.channelBoosted).toBe(false);
    // The boost is a multiplier on a negative score, so it can only improve it.
    expect(boosted[0].score).toBeCloseTo(
      plain.find((h) => h.id === "whatsapp:m09")!.score * DEFAULT_CHANNEL_BOOST,
      6,
    );
  });

  it("leaves the ordering alone when nothing was named", () => {
    seedWeekendLunches();
    const plain = searchEventsRanked({ match: `"sunday" OR "lunch"` });
    expect(
      searchEventsRanked({
        match: `"sunday" OR "lunch"`,
        boostChannelIds: [],
      }).map((h) => h.id),
    ).toEqual(plain.map((h) => h.id));
    // A boost still cannot silence a chat: everything that matched comes back.
    expect(
      searchEventsRanked({
        match: `"sunday" OR "lunch"`,
        boostChannelIds: ["whatsapp:st:nope"],
      }).map((h) => h.id),
    ).toEqual(plain.map((h) => h.id));
  });
});

describe("searchChannelRanked", () => {
  it("ranks one chat's whole history and never leaves it", () => {
    const { streamId } = seedWeekendLunches();
    const other = upsertStream({
      sourceId: "whatsapp",
      sourceExtId: "shorts@g.us",
      name: "Shorts",
      kind: "group",
    });
    insertEvent({
      externalId: "s01",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: other,
      actorId: null,
      ts: "2026-08-01T12:20:00.000Z",
      kind: "message",
      text: "booked oye kake",
      mediaPath: null,
      rawJson: null,
    });

    const hits = searchChannelRanked({ channelId: streamId, match: `"booked"` });
    expect(hits.map((h) => h.id)).toEqual(["whatsapp:m09"]);
    // The corpus-wide search finds both; the pool is the point of this one.
    expect(searchEventsRanked({ match: `"booked"` }).map((h) => h.id)).toContain("whatsapp:s01");

    // No time or distance bound: the first and the last message of the chat are
    // equally reachable, which is what a window cannot do.
    const all = searchChannelRanked({ channelId: streamId, match: `"sunday" OR "booked"` });
    expect(all.map((h) => h.id)).toEqual(expect.arrayContaining(["whatsapp:m01", "whatsapp:m09"]));
  });

  it("skips reactions, and an unknown chat or an empty match is no rows", () => {
    const { streamId } = seedWeekendLunches();
    expect(searchChannelRanked({ channelId: streamId, match: `"🎉"` })).toEqual([]);
    expect(searchChannelRanked({ channelId: streamId, match: "  " })).toEqual([]);
    expect(searchChannelRanked({ channelId: "", match: `"booked"` })).toEqual([]);
    expect(searchChannelRanked({ channelId: "nope", match: `"booked"` })).toEqual([]);
  });
});

describe("readChannelEventIds", () => {
  it("is every non-reaction event in the given chats, and nothing for none", () => {
    const { streamId } = seedWeekendLunches();
    const ids = readChannelEventIds([streamId]);
    expect(ids).toHaveLength(WEEKEND_LUNCHES.length - 1);
    expect(ids).not.toContain("whatsapp:m10");
    expect(readChannelEventIds([])).toEqual([]);
    expect(readChannelEventIds(["nope"])).toEqual([]);
    // Duplicates are one chat, not two.
    expect(readChannelEventIds([streamId, streamId])).toHaveLength(ids.length);
  });
});
