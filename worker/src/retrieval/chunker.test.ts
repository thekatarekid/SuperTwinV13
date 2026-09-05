// ===========================================================================
// The chunker (V6 P1 S2.2, T5-3) — what gets a vector.
//
//   chat     rolling ≤ 2 k windows per stream, in ts order, incremental: a
//            second pass over the same log writes nothing; new messages extend
//            the open window and seal it when it fills; the short reply is in
//            the window with its neighbours.
//   screen   the reconstructed document per stream, recut on re-anchor —
//            unchanged windows keep their row (and so their vector).
//   browser  one chunk per visit, deduped by content hash within the host.
//   cards    episode summaries, space cards, active claims, people cards —
//            replaced when the text changes, dropped when the ref goes.
//
// Zero model calls: pure SQLite on a temp file.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-chunker-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { appendEvent } = await import("../db/eventlog.js");
const { chunksFor, chunkCount, putChunkEmbedding, getChunkEmbedding } = await import("../db/v6graph.js");
const { createEntity } = await import("../entities/registry.js");
const { writeClaimVersion } = await import("../claims/store.js");
const {
  CHUNK_TARGET_CHARS,
  actorLabel,
  browserVisitText,
  chunkBrowserVisits,
  chunkCards,
  chunkChatStreams,
  chunkScreenStreams,
  cutDocument,
  cutWindows,
  resetChunkerMarks,
  runChunker,
  stripUrl,
} = await import("./chunker.js");

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
let clock = 0;

function ts(offsetS = 1): string {
  clock += offsetS;
  return new Date(T0 + clock * 1000).toISOString();
}

function chat(streamKey: string, actor: string, text: string, when = ts()): string {
  return appendEvent({
    ts: when,
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor,
    roles: { sender: actor, audience: ["self", actor], receiver: ["self"], mentions: [] },
    payload: { text },
  }).id;
}

function screen(streamKey: string, newChars: string, title = "Goa villas — Airbnb", when = ts()): string {
  return appendEvent({
    ts: when,
    source: "screen",
    kind: "screen.snapshot",
    origin: "live",
    streamKey,
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: newChars, doc_key: streamKey, window_title: title, app_name: "Safari", content_hash: String(clock) },
  }).id;
}

function visit(url: string, title: string, when = ts()): string {
  return appendEvent({
    ts: when,
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: new URL(url).host,
    actor: "self",
    roles: { sender: "self", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { url, title, text: title },
  }).id;
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec(`DELETE FROM chunks; DELETE FROM events; DELETE FROM archive; DELETE FROM app_state WHERE key LIKE 'chunker.%';
           DELETE FROM episodes; DELETE FROM spaces; DELETE FROM claim_versions; DELETE FROM claims;
           DELETE FROM entities WHERE id <> 'ent_000000000000000000000000';`);
  resetChunkerMarks();
});

// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("cutWindows never exceeds the target unless one line does", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `rohan: message number ${i} ${"x".repeat(60)}`);
    const wins = cutWindows(lines, 500);
    expect(wins.length).toBeGreaterThan(5);
    for (const w of wins) expect(w.text.length).toBeLessThanOrEqual(500);
    // Contiguous, complete coverage in order.
    expect(wins[0].from).toBe(0);
    for (let i = 1; i < wins.length; i++) expect(wins[i].from).toBe(wins[i - 1].to + 1);
    expect(wins[wins.length - 1].to).toBe(lines.length - 1);
    const huge = cutWindows(["a".repeat(900)], 500);
    expect(huge).toHaveLength(1);
  });

  it("cutDocument splits on whitespace and keeps every character", () => {
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    const parts = cutDocument(words, 400);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(400);
    expect(parts.join(" ")).toBe(words);
  });

  it("stripUrl drops scheme, www, query and fragment", () => {
    expect(stripUrl("https://www.airbnb.co.in/rooms/123?source=x#photos")).toBe("airbnb.co.in/rooms/123");
    expect(stripUrl("http://example.com/")).toBe("example.com");
  });

  it("actorLabel prefers a display name, humanises self, strips the prefix", () => {
    expect(actorLabel({ actor: "contact:rohan", actor_name: null })).toBe("rohan");
    expect(actorLabel({ actor: "self", actor_name: null })).toBe("me");
    expect(actorLabel({ actor: "contact:x", actor_name: "Rohan Mehta" })).toBe("Rohan Mehta");
  });

  it("browserVisitText is title · stripped url", () => {
    expect(browserVisitText({ url: "https://www.airbnb.co.in/rooms/1?x=1", title: "Villa Serena" }, null)).toBe(
      "Villa Serena · airbnb.co.in/rooms/1",
    );
  });
});

describe("chat windows", () => {
  it("cuts a stream into ≤ 2k windows in ts order and finds the short reply in its window", () => {
    const stream = "goa-gang@g.us";
    for (let i = 0; i < 60; i++) chat(stream, "contact:rohan", `plan item ${i}: ${"beach house options and dates ".repeat(3)}`);
    chat(stream, "contact:rohan", "so are we confirming the villa with the pool?");
    const yes = chat(stream, "self", "yes, book it");
    for (let i = 0; i < 10; i++) chat(stream, "contact:priya", `after that ${i} ${"more chatter ".repeat(4)}`);

    const r = chunkChatStreams();
    expect(r.streams).toBe(1);
    const rows = chunksFor("chat", { streamKey: stream });
    expect(rows.length).toBeGreaterThan(2);
    for (const c of rows) expect(c.textLen).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    rows.forEach((c, i) => expect(c.seq).toBe(i));
    // Every window carries speaker-prefixed lines and its event ids.
    const withYes = rows.find((c) => c.eventIds.includes(yes));
    expect(withYes).toBeDefined();
    expect(withYes!.text).toContain("me: yes, book it");
    expect(withYes!.text).toContain("confirming the villa");
    expect(withYes!.tsStart! <= withYes!.tsEnd!).toBe(true);
  });

  it("a second pass writes nothing; new messages extend the open window, then seal it", () => {
    const stream = "priya@s.whatsapp.net";
    chat(stream, "contact:priya", "lunch on sunday?");
    chat(stream, "self", "haan, oye kake");
    expect(chunkChatStreams().chunks).toBe(1);
    const first = chunksFor("chat", { streamKey: stream });
    expect(first).toHaveLength(1);
    expect(first[0].eventIds).toHaveLength(2);

    // Nothing new → nothing written, nothing deleted.
    expect(chunkChatStreams()).toEqual({ streams: 0, chunks: 0 });
    expect(chunksFor("chat", { streamKey: stream })).toHaveLength(1);

    // One more message → the open window is rewritten to include it.
    const third = chat(stream, "contact:priya", "1pm then");
    chunkChatStreams();
    const after = chunksFor("chat", { streamKey: stream });
    expect(after).toHaveLength(1);
    expect(after[0].eventIds).toContain(third);
    expect(after[0].text.split("\n")).toHaveLength(3);

    // Enough to overflow → the old window seals, a new open one starts, and
    // the sealed one is never re-cut on the next pass.
    for (let i = 0; i < 40; i++) chat(stream, "contact:priya", `${i} ${"long message text ".repeat(6)}`);
    chunkChatStreams();
    const sealed = chunksFor("chat", { streamKey: stream });
    expect(sealed.length).toBeGreaterThan(1);
    const texts = sealed.map((c) => c.text);
    chat(stream, "self", "ok");
    chunkChatStreams();
    const again = chunksFor("chat", { streamKey: stream });
    for (let i = 0; i < sealed.length - 1; i++) expect(again[i].text).toBe(texts[i]);
    expect(again[again.length - 1].text.endsWith("me: ok")).toBe(true);
  });

  it("skips reactions and revoked rows and ignores screen/browser sources", () => {
    chat("s1", "contact:a", "hello there friend");
    appendEvent({
      ts: ts(),
      source: "wa",
      kind: "reaction",
      origin: "live",
      streamKey: "s1",
      actor: "contact:a",
      roles: { sender: "contact:a", audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: "👍" },
    });
    screen("com.apple.Safari¦doc", "some page text");
    chunkChatStreams();
    const rows = chunksFor("chat", { streamKey: "s1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("a: hello there friend");
    expect(chunkCount("screen")).toBe(0);
  });
});

describe("screen documents", () => {
  it("reconstructs the document from diffs, cuts 2k windows, recuts on re-anchor keeping unchanged rows", () => {
    const key = "com.apple.Safari¦airbnb-villa";
    screen(key, "Villa Serena. 6 beds, swimming pool. " + "amenity list ".repeat(400));
    chunkScreenStreams();
    const first = chunksFor("screen", { streamKey: key });
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first[0].text.startsWith("Safari — Goa villas — Airbnb")).toBe(true);
    for (const c of first) expect(c.textLen).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + 40);
    // A vector on the first window survives a re-anchor that only appends.
    putChunkEmbedding(first[0].id, new Float32Array([0.1, 0.2, 0.3, 0.4]), "fake");
    screen(key, "Reviews: 4.9 · superhost · " + "review text ".repeat(200));
    const r = chunkScreenStreams();
    expect(r.streams).toBe(1);
    const second = chunksFor("screen", { streamKey: key });
    expect(second.length).toBeGreaterThan(first.length);
    expect(second[0].id).toBe(first[0].id);
    expect(getChunkEmbedding(first[0].id)).not.toBeNull();
    // Nothing new → nothing happens.
    expect(chunkScreenStreams()).toEqual({ streams: 0, chunks: 0 });
  });
});

describe("browser visits", () => {
  it("one chunk per visit, deduped by content hash within the host", () => {
    visit("https://www.airbnb.co.in/rooms/1?src=a", "Villa Serena");
    visit("https://www.airbnb.co.in/rooms/1?src=b", "Villa Serena");
    visit("https://www.airbnb.co.in/rooms/2", "Villa Azul");
    visit("https://news.ycombinator.com/", "Hacker News");
    expect(chunkBrowserVisits()).toBe(3);
    const air = chunksFor("browser", { streamKey: "airbnb.co.in" });
    expect(air.map((c) => c.text).sort()).toEqual(["Villa Azul · airbnb.co.in/rooms/2", "Villa Serena · airbnb.co.in/rooms/1"]);
    expect(chunkBrowserVisits()).toBe(0);
    visit("https://news.ycombinator.com/", "Hacker News");
    expect(chunkBrowserVisits()).toBe(0);
    expect(chunkCount("browser")).toBe(3);
  });
});

describe("cards", () => {
  it("episode summaries, space cards, active claims and people cards; replaced on change, dropped with the ref", () => {
    const db = getDb();
    db.prepare(`INSERT INTO episodes (id, state, summary, last_ts) VALUES ('ep1', 'open', 'Goa villa hunt with the gang', ?)`).run(ts());
    db.prepare(`INSERT INTO spaces (id, label, goal, status, life_area) VALUES ('sp1', 'Goa trip Oct', 'book a villa for 8', 'active', 'travel')`).run();
    const ev = chat("s", "contact:rohan", "villa advance paid 5400");
    const person = createEntity({ type: "person", canonical: "Rohan Mehta", subtype: null }).id;
    writeClaimVersion({
      claimKey: "clm:villa-advance",
      kind: "fact",
      subjectId: person,
      text: "paid ₹5,400 villa advance to Rohan",
      statedAt: ts(),
      confidence: 0.9,
      evidence: [{ event_ids: [ev], quote: "villa advance paid 5400" }],
      decidedBy: "test",
    });

    expect(chunkCards()).toBe(4);
    expect(chunksFor("episode", { refId: "ep1" })[0].text).toBe("Goa villa hunt with the gang");
    expect(chunksFor("space", { refId: "sp1" })[0].text).toBe("Goa trip Oct\nbook a villa for 8\ntravel · active");
    expect(chunksFor("claim", { refId: "clm:villa-advance" })[0].text).toContain("₹5,400");
    expect(chunksFor("person", { refId: person })[0].text).toBe("Rohan Mehta");
    expect(chunkCount("person")).toBe(1); // self is not a card

    // Idempotent.
    expect(chunkCards()).toBe(0);
    // Changed text replaces the card; removed ref drops it.
    db.prepare(`UPDATE episodes SET summary = 'Goa villa booked — Villa Serena' WHERE id = 'ep1'`).run();
    db.prepare(`DELETE FROM spaces WHERE id = 'sp1'`).run();
    expect(chunkCards()).toBe(1);
    expect(chunksFor("episode", { refId: "ep1" })).toHaveLength(1);
    expect(chunksFor("episode", { refId: "ep1" })[0].text).toContain("Villa Serena");
    expect(chunkCount("space")).toBe(0);
  });
});

describe("runChunker", () => {
  it("reports every kind in one pass", () => {
    chat("s", "contact:a", "some message about dinner tonight");
    screen("app¦doc", "document text here");
    visit("https://example.com/a", "Example A");
    const r = runChunker();
    expect(r).toEqual({ chatStreams: 1, chatChunks: 1, screenStreams: 1, screenChunks: 1, browserChunks: 1, cardChunks: 0 });
    expect(runChunker()).toEqual({ chatStreams: 0, chatChunks: 0, screenStreams: 0, screenChunks: 0, browserChunks: 0, cardChunks: 0 });
  });
});
