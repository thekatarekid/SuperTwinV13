// ===========================================================================
// Bar type-ahead (build S2.7) — BAR-01 and RET-04 as deterministic code cases.
//
//   BAR-01  "goa vill" on a seeded DB → events, episodes and Goa › Stay,
//           under 150 ms, 0 model calls. The seed is a fixed PRNG so the
//           timing is over the same rows every run.
//   RET-04  an event outside the Understand window appears in search, cited
//           by its archive id, labelled searchable-only, carries no episode.
//
// Zero model calls: the module never touches an embedder or a runner; the
// suite pins that with the `runs` ledger staying empty.
// ===========================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-typeahead-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { setConsentGateMode } = await import("../db/consent-gate.js");
const { appendEvents } = await import("../db/eventlog.js");
const { grantConsent, readArchiveByEvent } = await import("../db/v6core.js");
const { createEntity } = await import("../entities/registry.js");
const {
  TYPEAHEAD_BUDGET_MS,
  resetTypeaheadForTests,
  typeahead,
  typeaheadMatch,
  typeaheadTokens,
} = await import("./typeahead.js");

type EventEnvelope = import("../db/eventlog.js").EventEnvelope;

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function daysAgo(n: number, minutes = 0): string {
  return new Date(NOW - n * DAY + minutes * 60_000).toISOString();
}

function envelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    ts: daysAgo(0),
    source: "wa",
    kind: "wa.message",
    origin: "backfill",
    streamKey: "goa-gang@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: "guys lets lock goa 18-21 dec" },
    ...overrides,
  };
}

/** mulberry32 — a fixed seed makes the BAR-01 DB the same rows every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = [
  "lunch", "call", "tomorrow", "invoice", "sent", "meeting", "gym", "flight", "delhi", "mumbai",
  "rent", "plumber", "doctor", "birthday", "photos", "movie", "sunday", "office", "deadline", "coffee",
  "uber", "receipt", "paid", "pending", "okay", "done", "later", "morning", "night", "weekend",
];
const STREAMS = ["goa-gang@g.us", "family@g.us", "rohan@s", "ma@s", "office@g.us", "karan@s", "batch@g.us", "priya@s"];
const ACTORS = ["contact:rohan", "contact:karan", "contact:priya", "contact:ma", "self"];

function runsCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
}

function reset(): void {
  closeDb();
  rmSync(process.env.SUPERTWIN_DB_PATH!, { force: true });
  rmSync(`${process.env.SUPERTWIN_DB_PATH}-wal`, { force: true });
  rmSync(`${process.env.SUPERTWIN_DB_PATH}-shm`, { force: true });
  runMigrations();
  resetTypeaheadForTests();
}

/**
 * The BAR-01 world: ~3,000 chat events across eight streams (≈45 about a Goa
 * villa), 40 spaces, the Goa space's "Stay" chapter, 300 episodes (5 villa
 * episodes filed under Goa › Stay), 200 tasks, 120 people, 200 claims.
 */
function seedBar01World(): { goaSpaceId: string; stayChapterId: string } {
  const rnd = prng(20260901);
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const db = getDb();

  const envs: EventEnvelope[] = [];
  for (let i = 0; i < 3000; i++) {
    const villa = i % 66 === 0;
    const words = Array.from({ length: 4 + Math.floor(rnd() * 8) }, () => pick(VOCAB));
    const text = villa
      ? `${pick(["which", "that", "the"])} goa villa ${pick(["6k per night", "with pool", "near anjuna", "advance by 5pm"])} #${i}`
      : `${words.join(" ")} #${i}`;
    envs.push(
      envelope({
        ts: daysAgo(Math.floor(rnd() * 180), Math.floor(rnd() * 1440)),
        streamKey: villa ? "goa-gang@g.us" : pick(STREAMS),
        actor: pick(ACTORS),
        payload: { text },
      }),
    );
  }
  for (let i = 0; i < envs.length; i += 500) appendEvents(envs.slice(i, i + 500), NOW);

  const insSpace = db.prepare(`INSERT INTO spaces (id, label, status, life_area) VALUES (?, ?, ?, ?)`);
  insSpace.run("sp_goa", "Goa dec trip", "active", "Travel");
  for (let i = 1; i < 40; i++) {
    insSpace.run(`sp_${i}`, `${pick(["Money", "Health", "Home", "Work", "Kids"])} ${pick(VOCAB)} ${i}`, i % 7 === 0 ? "archived" : "active", null);
  }
  db.prepare(`INSERT INTO chapters (id, space_id, label, status) VALUES (?, ?, ?, ?)`).run("ch_stay", "sp_goa", "Stay", "active");
  db.prepare(`INSERT INTO chapters (id, space_id, label, status) VALUES (?, ?, ?, ?)`).run("ch_travel", "sp_goa", "Getting there", "active");

  const insEpisode = db.prepare(
    `INSERT INTO episodes (id, space_id, chapter_id, state, summary, first_ts, last_ts, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'orient')`,
  );
  for (let i = 0; i < 300; i++) {
    const villa = i % 60 === 0;
    const ts = daysAgo(Math.floor(rnd() * 180));
    insEpisode.run(
      `ep_${i}`,
      villa ? "sp_goa" : `sp_${1 + Math.floor(rnd() * 39)}`,
      villa ? "ch_stay" : null,
      i % 5 === 0 ? "closed" : "open",
      villa ? `Goa villa shortlist — ${pick(["budget 6k/night", "pool vs beach", "Rohan's pick"])} (${i})` : `${pick(VOCAB)} ${pick(VOCAB)} thread ${i}`,
      ts,
      ts,
    );
  }

  const insTask = db.prepare(`INSERT INTO tasks (id, space_id, title, status, type) VALUES (?, ?, ?, ?, 'implicit')`);
  for (let i = 0; i < 200; i++) {
    const villa = i % 50 === 0;
    insTask.run(
      `tk_${i}`,
      villa ? "sp_goa" : null,
      villa ? `pay goa villa advance (${i})` : `${pick(VOCAB)} ${pick(VOCAB)} ${i}`,
      i % 3 === 0 ? "done" : "open",
    );
  }

  const FIRST = ["Rohan", "Karan", "Priya", "Ma", "Aditi", "Vikram", "Neha", "Sameer", "Villy", "Gauri"];
  const LAST = ["Mehta", "Shah", "Iyer", "Villanueva", "Rao", "Kapoor", "Nair", "Joshi", "Bose", "Das"];
  for (let i = 0; i < 120; i++) {
    createEntity({ type: "person", canonical: `${FIRST[i % 10]} ${LAST[Math.floor(i / 10) % 10]} ${i}`, provisional: false });
  }

  const insClaim = db.prepare(
    `INSERT INTO claims (claim_key, kind, status, active_version_id, version_count, first_stated_at, last_stated_at)
     VALUES (?, 'fact', 'active', ?, 1, ?, ?)`,
  );
  const insVersion = db.prepare(
    `INSERT INTO claim_versions (id, claim_key, kind, predicate, text, stated_at) VALUES (?, ?, 'fact', 'says', ?, ?)`,
  );
  for (let i = 0; i < 200; i++) {
    const villa = i % 40 === 0;
    const ts = daysAgo(Math.floor(rnd() * 180));
    insVersion.run(`cv_${i}`, `ck_${i}`, villa ? `the goa villa is 6k per night max (${i})` : `${pick(VOCAB)} is ${pick(VOCAB)} ${i}`, ts);
    insClaim.run(`ck_${i}`, `cv_${i}`, ts, ts);
  }
  return { goaSpaceId: "sp_goa", stayChapterId: "ch_stay" };
}

beforeEach(() => {
  reset();
  setConsentGateMode("open");
});

afterEach(() => {
  setConsentGateMode("open");
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("tokens and MATCH", () => {
  it("lowercases, strips punctuation, drops 1-char and noise, dedupes, caps at six", () => {
    expect(typeaheadTokens('  Goa, "Vill  ')).toEqual(["goa", "vill"]);
    expect(typeaheadTokens("a b c")).toEqual([]);
    expect(typeaheadTokens("goa goa GOA")).toEqual(["goa"]);
    expect(typeaheadTokens("one two three four five six seven")).toHaveLength(6);
    expect(typeaheadTokens("!! -- ??")).toEqual([]);
  });

  it("every token becomes an FTS5 prefix", () => {
    expect(typeaheadMatch(["goa", "vill"])).toBe('"goa"* AND "vill"*');
    expect(typeaheadMatch(["goa", "vill"], "OR")).toBe('"goa"* OR "vill"*');
  });
});

describe("empty and noise queries", () => {
  it("return empty groups without touching the DB", () => {
    const r = typeahead("   ");
    expect(r.tokens).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.spaces).toEqual([]);
    expect(r.model_calls).toBe(0);
    expect(r.took_ms).toBeLessThan(TYPEAHEAD_BUDGET_MS);
  });
});

describe("BAR-01 — type-ahead is local", () => {
  it('"goa vill" → events, episodes and Goa › Stay under 150 ms with 0 model calls', () => {
    const { goaSpaceId, stayChapterId } = seedBar01World();
    const runsBefore = runsCount();

    // Cold call: statement preparation included in the budget.
    const cold = typeahead("goa vill");
    expect(cold.took_ms).toBeLessThan(TYPEAHEAD_BUDGET_MS);

    const timings: number[] = [];
    let last = cold;
    for (let i = 0; i < 7; i++) {
      last = typeahead("goa vill");
      timings.push(last.took_ms);
    }
    const sorted = [...timings].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    expect(median).toBeLessThan(TYPEAHEAD_BUDGET_MS);
    expect(Math.max(...timings)).toBeLessThan(TYPEAHEAD_BUDGET_MS);

    // Events: every hit is a Goa villa line, ranked, with the chat named.
    expect(last.events.length).toBeGreaterThan(0);
    for (const hit of last.events) {
      expect(hit.snippet.toLowerCase()).toMatch(/goa/);
      expect(hit.snippet.toLowerCase()).toMatch(/vill/);
      expect(hit.chat).toBe("goa-gang@g.us");
      expect(hit.searchable_only).toBe(false);
      expect(hit.archive_id).toEqual(expect.any(String));
    }
    // Episodes: the villa shortlist threads, newest first.
    expect(last.episodes.length).toBeGreaterThan(0);
    for (const ep of last.episodes) expect(ep.summary).toMatch(/^Goa villa shortlist/);
    const lastTs = last.episodes.map((e) => e.last_ts ?? "");
    expect([...lastTs].sort().reverse()).toEqual(lastTs);
    // Spaces: the chapter path of the matched episodes FIRST, then the space itself.
    expect(last.spaces[0]).toEqual({ id: goaSpaceId, label: "Goa dec trip › Stay", chapter_id: stayChapterId });
    expect(last.spaces.some((s) => s.id === goaSpaceId && s.chapter_id === null && s.label === "Goa dec trip")).toBe(true);
    // Tasks, claims: the villa ones; people: only names with a word starting vill/goa.
    expect(last.tasks.length).toBeGreaterThan(0);
    for (const t of last.tasks) expect(t.title).toMatch(/goa villa/);
    expect(last.claims.length).toBeGreaterThan(0);
    for (const c of last.claims) expect(c.text).toMatch(/goa villa/);
    expect(last.people.length).toBeGreaterThan(0);
    for (const p of last.people) expect(p.name).toMatch(/\b(Vill|Goa)/);

    // No model: nothing in the ledger, and the result says so.
    expect(last.model_calls).toBe(0);
    expect(runsCount()).toBe(runsBefore);
    expect(runsBefore).toBe(0);
  });

  it("people: a word-prefix on the canonical name; merged aliases hidden; pinned first", () => {
    seedBar01World();
    const r = typeahead("vill");
    // "Villy …" and "… Villanueva …" both start a word with vill.
    expect(r.people.length).toBeGreaterThan(0);
    for (const p of r.people) expect(p.name).toMatch(/\bVill/);
    // A merged alias never surfaces.
    const alias = createEntity({ type: "person", canonical: "Villager Alias", provisional: true });
    getDb().prepare(`UPDATE entities SET merged_into = (SELECT id FROM entities WHERE type='person' AND merged_into IS NULL LIMIT 1) WHERE id = ?`).run(alias.id);
    expect(typeahead("villager").people).toEqual([]);
  });

  it("tasks: open work before closed; claims: only the active version", () => {
    seedBar01World();
    const db = getDb();
    db.prepare(`INSERT INTO tasks (id, title, status, type) VALUES ('tk_x1', 'goa villa deposit refund', 'done', 'implicit')`).run();
    db.prepare(`INSERT INTO tasks (id, title, status, type) VALUES ('tk_x2', 'goa villa keys pickup', 'open', 'implicit')`).run();
    const tasks = typeahead("goa villa", { limit: 50 }).tasks;
    const firstDone = tasks.findIndex((t) => ["done", "cancelled", "dismissed"].includes(t.status));
    const lastOpen = tasks.map((t) => t.status).lastIndexOf("open");
    expect(firstDone === -1 || lastOpen < firstDone).toBe(true);

    db.prepare(`UPDATE claims SET status = 'closed' WHERE claim_key = 'ck_0'`).run();
    expect(typeahead("goa villa", { limit: 50 }).claims.some((c) => c.claim_key === "ck_0")).toBe(false);
  });

  it("AND falls back to OR when no row has every prefix", () => {
    seedBar01World();
    const r = typeahead("goa zzzq");
    expect(r.events.length).toBeGreaterThan(0);
    for (const hit of r.events) expect(hit.snippet.toLowerCase()).toMatch(/goa/);
  });

  it("LIKE wildcards in the query are literal", () => {
    seedBar01World();
    expect(typeahead("%%").tokens).toEqual([]);
    // "50_" keeps its underscore; unescaped it would match "thread 500".
    expect(typeahead("50").episodes.length).toBeGreaterThan(0);
    expect(typeahead("50_").tokens).toEqual(["50_"]);
    expect(typeahead("50_").episodes).toEqual([]);
    expect(typeahead("50_").tasks).toEqual([]);
    expect(typeahead("50_").claims).toEqual([]);
  });

  it("an optional semantic hook appends deduped candidates and never counts as a model", () => {
    seedBar01World();
    const lexical = typeahead("goa vill");
    const dup = lexical.events[0]!;
    const r = typeahead("goa vill", {
      semantic: () => [dup, { ...dup, id: "ev_semantic", snippet: "semantic villa", searchable_only: false, archive_id: null, episode_id: null }],
    });
    expect(r.events.filter((e) => e.id === dup.id)).toHaveLength(1);
    expect(r.events.some((e) => e.id === "ev_semantic")).toBe(true);
    expect(r.model_calls).toBe(0);
  });
});

describe("RET-04 — archive-only rows are searchable", () => {
  it("appears in search, cited by archive id, labelled searchable-only, carries no episode", () => {
    setConsentGateMode("enforce");
    grantConsent({ source: "wa", indexAll: true, understandFrom: daysAgo(30) });
    const res = appendEvents(
      [
        envelope({ ts: daysAgo(120), payload: { text: "old quote: goa villa 6k per night, ok?" } }),
        envelope({ ts: daysAgo(2), origin: "live", payload: { text: "goa villa deposit paid" } }),
      ],
      NOW,
    );
    expect(res.inserted).toBe(2);
    const [oldId, recentId] = res.ids as [string, string];
    const db = getDb();
    expect((db.prepare(`SELECT origin FROM events WHERE id = ?`).get(oldId) as { origin: string }).origin).toBe("archive");

    // The recent event is filed into an episode; the archive row never can be.
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_goa', 'Goa dec trip', 'active')`).run();
    db.prepare(`INSERT INTO episodes (id, space_id, state, summary) VALUES ('ep_villa', 'sp_goa', 'open', 'villa deposit')`).run();
    const rowid = (db.prepare(`SELECT rowid FROM events WHERE id = ?`).get(recentId) as { rowid: number }).rowid;
    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid, event_id)
       VALUES ('ee1', 'ep_villa', ?, ?, ?, ?, ?)`,
    ).run(recentId, recentId, rowid, rowid, recentId);

    const r = typeahead("goa villa");
    const old = r.events.find((e) => e.id === oldId);
    const recent = r.events.find((e) => e.id === recentId);
    expect(old).toBeDefined();
    expect(recent).toBeDefined();

    expect(old!.searchable_only).toBe(true);
    expect(old!.archive_id).toBe(readArchiveByEvent(oldId)!.id);
    expect(old!.episode_id).toBeNull();
    expect(old!.snippet).toMatch(/old quote/);

    expect(recent!.searchable_only).toBe(false);
    expect(recent!.archive_id).toBe(readArchiveByEvent(recentId)!.id);
    expect(recent!.episode_id).toBe("ep_villa");
    expect(r.model_calls).toBe(0);
  });
});
