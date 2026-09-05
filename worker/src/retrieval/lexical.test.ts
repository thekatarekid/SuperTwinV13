// ===========================================================================
// Lexical retrieval (V6 P1 S2.3) — RET-06 as vitest, plus the contract the
// fusion layer (S2.4) reads.
//
//   RET-06  "the tab about villas" finds a screen event by its WINDOW TITLE.
//           The event's text is the window's diff ("6 beds · swimming pool ·
//           ₹18,000 / night") and never says "villa"; the title does. Before
//           0202 the title lived only in payload_json and the question was
//           structurally unanswerable by FTS.
//
//   Plus: a browser tab is found the same way (title → window_title); the
//   app name and doc_key are searchable; chunks and cards rank under one
//   BM25 with a kind filter; ranks are 1-based and contiguous; an empty or
//   all-stopword question returns empty lists; FTS syntax garbage degrades to
//   empty rather than throwing.
//
// Zero model calls: pure SQLite on a temp file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toScreenEnvelope } from "../adapters/screen/envelope.js";
import { closeDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import { upsertChunk } from "../db/v6graph.js";
import { villaFrame } from "./__fixtures__/screen-frames.js";
import {
  DEFAULT_LEXICAL_CHUNK_LIMIT,
  DEFAULT_LEXICAL_EVENT_LIMIT,
  lexicalSearch,
  MAX_LEXICAL_LIMIT,
  resetLexicalStatementsForTests,
  searchChunksLexical,
  searchEventsLexical,
} from "./lexical.js";

let tmpDir: string;
const NOW = new Date("2026-09-02T09:00:00.000Z");

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-lexical-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  resetLexicalStatementsForTests();
  runMigrations();
});

afterEach(() => {
  closeDb();
  resetLexicalStatementsForTests();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const SELF = { sender: "self", audience: ["self"], receiver: [], mentions: [] };

function chat(text: string, ts = "2026-09-01T09:00:00.000Z", actor = "contact:rohan"): string {
  const { id } = appendEvent({
    ts,
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "9198xx-1602@g.us",
    actor,
    roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  });
  return id;
}

function browserVisit(title: string, url: string, ts = "2026-09-01T11:00:00.000Z"): string {
  const env: EventEnvelope = {
    ts,
    source: "browser",
    kind: "browser.visit",
    origin: "live",
    streamKey: new URL(url).host,
    actor: "self",
    roles: SELF,
    payload: { url, title, transition: "link", referrer: null, visit_count: 1, dwell_ms: 4000, domain: new URL(url).host, category: "other", browser: "chrome" },
  };
  return appendEvent(env).id;
}

/** A corpus where nothing but the screen event's TITLE says "villa". */
function seedCorpus(): { screen: string; chats: string[] } {
  const chats = [
    chat("lunch sunday? the usual place", "2026-08-30T12:00:00.000Z"),
    chat("advance by 5pm pls", "2026-08-31T16:00:00.000Z"),
    chat("yes, book it", "2026-08-31T16:05:00.000Z", "self"),
    chat("tab kholke dekh, 6 beds wala", "2026-09-01T10:10:00.000Z"),
  ];
  const screen = appendEvent(toScreenEnvelope(villaFrame())).id;
  return { screen, chats };
}

describe("RET-06 — the FTS projection finds a screen event by its window title", () => {
  it('"the tab about villas" → the Safari window titled "Villas in Goa – Airbnb"', () => {
    const { screen } = seedCorpus();
    const { plan, events } = lexicalSearch("the tab about villas", { now: NOW });
    // Stopwords dropped; content words + stem prefix kept.
    expect(plan.terms).toEqual(["tab", "villas"]);
    expect(plan.dropped).toEqual(["the", "about"]);
    expect(events.length).toBeGreaterThan(0);
    const top = events[0];
    expect(top.id).toBe(screen);
    expect(top.rank).toBe(1);
    expect(top.eventKind).toBe("screen.snapshot");
    expect(top.source).toBe("screen");
    expect(top.matchedColumn).toBe("window_title");
    expect(top.snippet).toContain("Villas");
    expect(top.app).toBe("Safari");
    expect(top.windowTitle).toBe("Villas in Goa – Airbnb");
    expect(top.docKey).toBe("airbnb.com/s/Goa/homes");
  });

  it("the diff alone would not have found it — the title is the only column that says villa", () => {
    const { screen } = seedCorpus();
    // Search restricted to the seven pre-0202 columns (weights 0 on the projection).
    const withoutProjection = searchEventsLexical('"villas" OR "vill"*', {
      weights: { app: 0, window_title: 0, doc_key: 0 },
    });
    // bm25 still MATCHes across all columns; but with the projected columns
    // weighted out, the hit's matched column falls back to 0 and there is no
    // other column that contains the token: the row is only reachable via the
    // projection. Assert that directly on the index.
    const viaText = searchEventsLexical('text : villas OR text : vill*');
    expect(viaText.map((h) => h.id)).not.toContain(screen);
    const viaTitle = searchEventsLexical('window_title : villas');
    expect(viaTitle.map((h) => h.id)).toEqual([screen]);
    expect(withoutProjection.map((h) => h.id)).toContain(screen);
  });

  it("a browser tab is found the same way — its title projects into window_title", () => {
    seedCorpus();
    const visit = browserVisit("Beach villas near Anjuna — Airbnb", "https://www.airbnb.com/s/Anjuna/homes");
    const { events } = lexicalSearch("the tab about villas", { now: NOW });
    const ids = events.map((h) => h.id);
    expect(ids).toContain(visit);
    const hit = events.find((h) => h.id === visit)!;
    expect(hit.matchedColumn).toBe("window_title");
    expect(hit.docKey).toBe("https://www.airbnb.com/s/Anjuna/homes");
  });

  it("the app name and the document key are searchable too", () => {
    const { screen } = seedCorpus();
    const byApp = lexicalSearch("safari", { now: NOW }).events;
    expect(byApp.map((h) => h.id)).toEqual([screen]);
    expect(byApp[0].matchedColumn).toBe("app");
    const byDoc = lexicalSearch("airbnb", { now: NOW }).events;
    expect(byDoc.map((h) => h.id)).toEqual([screen]);
    // "airbnb" is in both the title and the doc_key; the title's weight wins the attribution.
    expect(byDoc[0].matchedColumn).toBe("window_title");
  });

  it("a message that SAYS villa outranks a tab that was open on one", () => {
    const { screen } = seedCorpus();
    const said = chat("the villas with the pool — that one", "2026-09-01T12:00:00.000Z");
    // Both rows carry the same tokens ("villas" + "vill"*); the message wins on
    // column weight alone — text (4) outweighs window_title (3).
    const { events } = lexicalSearch("villas", { now: NOW });
    expect(events.map((h) => h.id).slice(0, 2)).toEqual([said, screen]);
    expect(events[0].matchedColumn).toBe("text");
  });
});

describe("BM25 over chunks and cards", () => {
  it("ranks a space card, a person card and a chat window under one index, filterable by kind", () => {
    const space = upsertChunk({ kind: "space", refId: "spc_goa", text: "Goa trip — villa shortlist, Nov 14–17. Rohan organising." }).id;
    const person = upsertChunk({ kind: "person", refId: "ent_rohan", text: "Rohan — cousin; organises the Goa villa trips" }).id;
    const window = upsertChunk({
      kind: "chat",
      source: "wa",
      streamKey: "9198xx-1602@g.us",
      eventIds: ["evt_a", "evt_b"],
      tsStart: "2026-08-31T16:00:00.000Z",
      tsEnd: "2026-08-31T16:05:00.000Z",
      text: "rohan: villa advance by 5pm?\nyou: yes, book it",
    }).id;
    upsertChunk({ kind: "browser", source: "browser", streamKey: "news.example", text: "Monsoon session: parliament adjourned" });

    const all = lexicalSearch("villa", { now: NOW }).chunks;
    expect(all.map((h) => h.id).sort()).toEqual([space, person, window].sort());
    expect(all.map((h) => h.rank)).toEqual([1, 2, 3]);
    expect(all.every((h) => h.kind === "chunk")).toBe(true);
    const win = all.find((h) => h.id === window)!;
    expect(win.chunkKind).toBe("chat");
    expect(win.eventIds).toEqual(["evt_a", "evt_b"]);
    expect(win.tsEnd).toBe("2026-08-31T16:05:00.000Z");
    expect(win.snippet).toContain("villa");

    const cards = lexicalSearch("villa", { now: NOW, chunkKinds: ["space", "person"] }).chunks;
    expect(cards.map((h) => h.id).sort()).toEqual([space, person].sort());
    expect(cards.map((h) => h.rank)).toEqual([1, 2]);

    expect(searchChunksLexical('"villa"', { kinds: [] })).toEqual([]);
  });

  it("the same question returns both lists — events and chunks — for fusion", () => {
    const { screen } = seedCorpus();
    const card = upsertChunk({ kind: "space", refId: "spc_goa", text: "Goa trip — villa shortlist" }).id;
    const r = lexicalSearch("the tab about villas", { now: NOW });
    expect(r.events[0].id).toBe(screen);
    expect(r.chunks.map((h) => h.id)).toEqual([card]);
  });
});

describe("bounds and degradation", () => {
  it("ranks are 1-based, contiguous, best-first, and the limit is honoured", () => {
    for (let i = 0; i < 12; i++) chat(`villa option ${i} — ${"pool ".repeat(i + 1)}`, `2026-09-01T0${i % 10}:00:00.000Z`);
    const hits = searchEventsLexical('"villa"', { limit: 5 });
    expect(hits).toHaveLength(5);
    expect(hits.map((h) => h.rank)).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < hits.length; i++) expect(hits[i].score).toBeGreaterThanOrEqual(hits[i - 1].score);
    expect(DEFAULT_LEXICAL_EVENT_LIMIT).toBe(2000);
    expect(DEFAULT_LEXICAL_CHUNK_LIMIT).toBe(2000);
    expect(MAX_LEXICAL_LIMIT).toBeGreaterThanOrEqual(DEFAULT_LEXICAL_EVENT_LIMIT);
  });

  it("nothing to search for → empty lists, no throw", () => {
    seedCorpus();
    expect(lexicalSearch("", { now: NOW })).toMatchObject({ events: [], chunks: [] });
    expect(lexicalSearch("   ", { now: NOW })).toMatchObject({ events: [], chunks: [] });
    expect(lexicalSearch("!!! ---", { now: NOW })).toMatchObject({ events: [], chunks: [] });
  });

  it("an FTS5 syntax error is an empty method, not a failed question", () => {
    seedCorpus();
    expect(searchEventsLexical('"unterminated')).toEqual([]);
    expect(searchChunksLexical("AND OR NOT")).toEqual([]);
  });

  it("reactions are not evidence", () => {
    appendEvent({
      ts: "2026-09-01T09:30:00.000Z",
      source: "wa",
      kind: "reaction",
      origin: "live",
      streamKey: "9198xx-1602@g.us",
      actor: "contact:rohan",
      roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
      payload: { text: "villa 👍" },
    });
    expect(lexicalSearch("villa", { now: NOW }).events).toEqual([]);
  });
});
