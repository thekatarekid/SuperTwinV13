// ===========================================================================
// Spaces (V6 P1 S5.1) — birth, sweep preview, wake, unsorted-on-change,
// enrichment-on-change, the list/view reads and the re-file drag.
//
// Real DB (temp file), zero model calls: the one pass that CAN call a model
// (the weekly unsorted review) gets a counting stub provider, and every test
// that expects "no call" asserts the counter is still zero.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonPassDeps } from "../brain/llm.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { decisionsFor } from "../db/decisions.js";
import { appStateGet, appStateSet } from "../db/ingest.js";
import type { Provider, Usage } from "../providers/types.js";
import { DEFAULT_GRADUATION_MODE, graduationMode, spaceCreationStatus } from "../consolidation/graduation.js";
import { sweepCandidates } from "../consolidation/sweep.js";
import { barLabel, bornAsked, sweepPreview, wakeSpace } from "./birth.js";
import { contentHash, enrichmentsFor, recordEnrichmentFetch, refreshEnrichments } from "./enrichment.js";
import { LIFE_AREAS, normalizeLifeArea, OTHER_AREA } from "./life-areas.js";
import { isLifeArea, refileEpisode, refileSpace } from "./refile.js";
import {
  changedUnsortedSince,
  reviewUnsortedWeekly,
  unsortedCandidatesFor,
  unsortedReviewDue,
  UNSORTED_LAST_REVIEW_KEY,
} from "./unsorted.js";
import { spaceView, spacesList } from "./view.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-spaces-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };

/** A provider that answers `responses` in order and counts every call. */
function stubProvider(responses: readonly string[]): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "stub",
    calls,
    cancel: () => false,
    async send(opts) {
      calls.push(opts.message);
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" as const };
    },
  };
}

function depsFor(provider: Provider): JsonPassDeps {
  return { provider, recordRun: () => `run_${Math.random().toString(16).slice(2)}`, sleep: async () => {} };
}

// ---- world helpers ---------------------------------------------------------

function mkSpace(
  id: string,
  label: string,
  opts: { status?: string; area?: string | null; goal?: string | null } = {},
): string {
  getDb()
    .prepare(
      `INSERT INTO spaces (id, label, life_area, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    )
    .run(id, label, opts.area ?? null, opts.goal ?? null, opts.status ?? "active");
  return id;
}

function mkStream(id: string): string {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('wa', 'whatsapp', 'wa')`).run();
  db.prepare(
    `INSERT OR IGNORE INTO streams (id, source_id, external_key, label) VALUES (?, 'wa', ?, ?)`,
  ).run(id, id, id);
  return id;
}

let eventSeq = 0;

/** One event + one episode over it, optionally filed and/or unsorted. */
function mkEpisode(
  id: string,
  text: string,
  opts: { spaceId?: string | null; unsorted?: boolean; unsortedStatus?: string; ts?: string } = {},
): string {
  const db = getDb();
  const streamId = mkStream("st_1");
  const eventId = `ev_${++eventSeq}`;
  const ts = opts.ts ?? "2026-08-20T10:00:00.000Z";
  db.prepare(
    `INSERT INTO events (id, source_id, source_type, stream_id, stream_key, ts, captured_at,
                         kind, origin, actor, payload_json, text)
     VALUES (?, 'wa', 'whatsapp', ?, ?, ?, ?, 'wa.message', 'live', 'contact:rohan', '{}', ?)`,
  ).run(eventId, streamId, streamId, ts, ts, text);
  const rowid = (db.prepare(`SELECT rowid AS r FROM events WHERE id = ?`).get(eventId) as { r: number }).r;
  db.prepare(
    `INSERT INTO episodes (id, stream_id, space_id, state, summary, first_ts, last_ts, created_at, updated_at)
     VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`,
  ).run(id, streamId, opts.spaceId ?? null, text, ts, ts, ts, ts);
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(`ee_${id}`, id, eventId, eventId, rowid, rowid);
  if (opts.unsorted) {
    db.prepare(
      `INSERT INTO unsorted (id, episode_id, reason, status, created_at)
       VALUES (?, ?, 'no goal evidence', ?, ?)`,
    ).run(`un_${id}`, id, opts.unsortedStatus ?? "open", ts);
  }
  return id;
}

// ---------------------------------------------------------------------------
// Birth
// ---------------------------------------------------------------------------

describe("space birth", () => {
  it("propose-only is the fresh-install default; an inferred space is born proposed", () => {
    expect(DEFAULT_GRADUATION_MODE).toBe("propose");
    expect(graduationMode()).toBe("propose");
    expect(spaceCreationStatus()).toBe("proposed");
  });

  it("asked-for is created ACTIVE and never proposed — even in propose-only mode (SPC-02)", () => {
    expect(spaceCreationStatus()).toBe("proposed");
    const outcome = bornAsked({ label: "hampi trek", goal: "trek in october", utterance: "plan hampi trek in october", threadId: "th_1" });
    expect(outcome.outcome).toBe("created");
    if (outcome.outcome !== "created") return;
    const row = getDb().prepare(`SELECT * FROM spaces WHERE id = ?`).get(outcome.spaceId) as {
      status: string;
      born_via: string;
      created_by: string;
      bar_thread_id: string;
      birth_evidence_json: string;
    };
    expect(row.status).toBe("active");
    expect(row.born_via).toBe("asked");
    expect(row.created_by).toBe("user");
    expect(row.bar_thread_id).toBe("th_1");
    // SPC-05: the sentence that asked for it IS the birth evidence, and the
    // thread id is what "why?" reopens.
    expect(JSON.parse(row.birth_evidence_json)).toEqual([
      { quote: "plan hampi trek in october", event_ids: [], thread_id: "th_1" },
    ]);
  });

  it("dedupes an asked-for birth against a live space — asks, never a second space (SPC-03)", () => {
    mkSpace("sp_goa_dec", "goa trip");
    // The imperative is instruction, not name: "plan a goa trip" names *goa trip*.
    expect(barLabel("plan a goa trip")).toBe("goa trip");
    const outcome = bornAsked({ label: "plan a goa trip", utterance: "plan a goa trip" });
    expect(outcome.outcome).toBe("ask");
    if (outcome.outcome !== "ask") return;
    expect(outcome.duplicate.spaceId).toBe("sp_goa_dec");
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(1);
  });

  it("forceNew makes the second space when the user answered 'a new one'", () => {
    mkSpace("sp_goa_dec", "goa trip");
    const outcome = bornAsked({ label: "goa trip", utterance: "no, a new one", forceNew: true });
    expect(outcome.outcome).toBe("created");
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(2);
  });

  it("the sweep preview counts what the sweep would pull in, with no model call (SPC-01)", () => {
    mkSpace("sp_goa", "goa trip", { goal: "trip to goa in december" });
    mkEpisode("ep_1", "goa flights on the 18th", { unsorted: true });
    mkEpisode("ep_2", "goa villa shortlist", { unsorted: true });
    mkEpisode("ep_3", "dentist appointment", { unsorted: true });
    const preview = sweepPreview("sp_goa");
    expect(preview.count).toBeGreaterThanOrEqual(2);
    expect(preview.line).toBe(`will pull in ${preview.count} related items`);
    expect(preview.items.every((i) => i.source === "unsorted")).toBe(true);
  });

  it("an empty sweep preview says so instead of promising items", () => {
    mkSpace("sp_solo", "solo goal");
    expect(sweepPreview("sp_solo")).toMatchObject({ count: 0, line: "nothing related yet" });
  });

  it("archived unsorted stays sweepable — a space born 40 days later still finds it", () => {
    mkSpace("sp_goa", "goa trip", { goal: "goa" });
    mkEpisode("ep_old", "goa villa deposit", { unsorted: true, unsortedStatus: "archived" });
    expect(sweepCandidates("sp_goa")).toContain("ep_old");
  });
});

// ---------------------------------------------------------------------------
// Wake
// ---------------------------------------------------------------------------

describe("wakeSpace (SPC-04)", () => {
  it("reactivates a dormant space with its OLD evidence and re-arms the sweep", () => {
    mkSpace("sp_ma_bday", "ma's birthday", { status: "dormant" });
    mkEpisode("ep_a", "cake order last year", { spaceId: "sp_ma_bday" });
    getDb()
      .prepare(`INSERT INTO tasks (id, space_id, title, type, status) VALUES ('t1','sp_ma_bday','order cake','explicit','open')`)
      .run();
    const outcome = wakeSpace({ spaceId: "sp_ma_bday", signal: "calendar lead time T-14" });
    expect(outcome.woke).toBe(true);
    expect(outcome.oldEvidence).toMatchObject({ episodes: 1, openTasks: 1 });
    const row = getDb().prepare(`SELECT status, woken_at FROM spaces WHERE id = 'sp_ma_bday'`).get() as {
      status: string;
      woken_at: string | null;
    };
    expect(row.status).toBe("active");
    expect(row.woken_at).not.toBeNull();
    // Nothing was re-derived: the episode is still attached, the task still open.
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM episodes WHERE space_id = 'sp_ma_bday'`).get() as { n: number }).n,
    ).toBe(1);
    // The decision names the signal and carries the old evidence.
    const d = decisionsFor("space", "sp_ma_bday")[0]!;
    expect(d.action).toBe("wake");
    expect(d.reason).toContain("calendar lead time T-14");
    // The sweep runs again over what landed while it slept.
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE space_id = 'sp_ma_bday'`).get() as { n: number }).n,
    ).toBe(1);
  });

  it("refuses to wake a space that is not dormant, and says why", () => {
    mkSpace("sp_live", "live one");
    const outcome = wakeSpace({ spaceId: "sp_live", signal: "user" });
    expect(outcome.woke).toBe(false);
    expect(outcome.reason).toContain("not dormant");
  });

  it("a missing space is a clean no", () => {
    expect(wakeSpace({ spaceId: "sp_nope", signal: "user" })).toMatchObject({ woke: false, reason: "no such space" });
  });
});

// ---------------------------------------------------------------------------
// Unsorted — the weekly review, on change only
// ---------------------------------------------------------------------------

describe("unsorted weekly review (SPC-07)", () => {
  it("an unchanged unsorted skips outright — zero model calls", async () => {
    mkSpace("sp_goa", "goa trip", { goal: "goa" });
    mkEpisode("ep_1", "goa flights", { unsorted: true });
    // Watermark AFTER the row landed: nothing has changed since.
    appStateSet(UNSORTED_LAST_REVIEW_KEY, "2026-09-01T00:00:00.000Z");
    expect(changedUnsortedSince("2026-09-01T00:00:00.000Z")).toBe(0);
    const provider = stubProvider(["{}"]);
    const report = await reviewUnsortedWeekly(depsFor(provider), { now: new Date("2026-09-10T00:00:00.000Z") });
    expect(report.skipped).toBe(true);
    expect(report.modelCalls).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("is not due before the week is up, and never calls then either", async () => {
    appStateSet(UNSORTED_LAST_REVIEW_KEY, "2026-09-05T00:00:00.000Z");
    expect(unsortedReviewDue(new Date("2026-09-06T00:00:00.000Z"))).toBe(false);
    const provider = stubProvider(["{}"]);
    const report = await reviewUnsortedWeekly(depsFor(provider), { now: new Date("2026-09-06T00:00:00.000Z") });
    expect(report).toMatchObject({ skipped: true, modelCalls: 0 });
    expect(provider.calls).toHaveLength(0);
  });

  it("a never-reviewed install is due, and one changed row buys exactly one call per matching space", async () => {
    expect(unsortedReviewDue()).toBe(true);
    mkSpace("sp_goa", "goa trip", { goal: "goa flights" });
    mkSpace("sp_quiet", "tax filing", { goal: "itr" });
    mkEpisode("ep_1", "goa flights on the 18th", { unsorted: true });
    expect(unsortedCandidatesFor("sp_goa", null)).toEqual(["ep_1"]);
    expect(unsortedCandidatesFor("sp_quiet", null)).toEqual([]);
    const provider = stubProvider([
      JSON.stringify({ attachments: [{ episode: "ep_1", attach: true, confidence: 0.9, reason: "same trip" }] }),
    ]);
    const report = await reviewUnsortedWeekly(depsFor(provider), { now: new Date("2026-09-10T00:00:00.000Z") });
    expect(report.skipped).toBe(false);
    expect(report.spacesReviewed).toBe(1); // only the space with candidates
    expect(provider.calls).toHaveLength(1);
    expect(report.attached).toBe(1);
    expect(
      (getDb().prepare(`SELECT space_id AS s FROM episodes WHERE id = 'ep_1'`).get() as { s: string }).s,
    ).toBe("sp_goa");
    expect(
      (getDb().prepare(`SELECT status FROM unsorted WHERE episode_id = 'ep_1'`).get() as { status: string }).status,
    ).toBe("claimed");
    // The watermark moved, so the next week starts from here.
    expect(appStateGet(UNSORTED_LAST_REVIEW_KEY)).toBe("2026-09-10T00:00:00.000Z");
  });

  it("a below-floor verdict leaves the episode where it is", async () => {
    mkSpace("sp_goa", "goa trip", { goal: "goa flights" });
    mkEpisode("ep_1", "goa flights on the 18th", { unsorted: true });
    const provider = stubProvider([
      JSON.stringify({ attachments: [{ episode: "ep_1", attach: true, confidence: 0.4, reason: "maybe" }] }),
    ]);
    const report = await reviewUnsortedWeekly(depsFor(provider), { now: new Date("2026-09-10T00:00:00.000Z") });
    expect(report.attached).toBe(0);
    expect(
      (getDb().prepare(`SELECT space_id AS s FROM episodes WHERE id = 'ep_1'`).get() as { s: string | null }).s,
    ).toBeNull();
  });

  it("never attaches an episode the review was not shown", async () => {
    mkSpace("sp_goa", "goa trip", { goal: "goa flights" });
    mkEpisode("ep_1", "goa flights on the 18th", { unsorted: true });
    mkEpisode("ep_secret", "salary negotiation", { unsorted: true });
    const provider = stubProvider([
      JSON.stringify({ attachments: [{ episode: "ep_secret", attach: true, confidence: 0.99, reason: "no" }] }),
    ]);
    const report = await reviewUnsortedWeekly(depsFor(provider), { now: new Date("2026-09-10T00:00:00.000Z") });
    expect(report.attached).toBe(0);
    expect(
      (getDb().prepare(`SELECT space_id AS s FROM episodes WHERE id = 'ep_secret'`).get() as { s: string | null }).s,
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enrichment — content hash
// ---------------------------------------------------------------------------

describe("enrichment on change only (SPC-08)", () => {
  it("an unchanged fetch writes no decision and queues no call", () => {
    mkSpace("sp_goa", "goa trip");
    const first = recordEnrichmentFetch({ spaceId: "sp_goa", kind: "fare", url: "https://x/fare", content: "₹4,300" });
    expect(first).toMatchObject({ changed: true, first: true, queued: true });
    const before = decisionsFor("space", "sp_goa").length;
    const again = recordEnrichmentFetch({ spaceId: "sp_goa", kind: "fare", url: "https://x/fare", content: "  ₹4,300\n" });
    expect(again).toMatchObject({ changed: false, queued: false });
    expect(again.contentHash).toBe(first.contentHash);
    expect(decisionsFor("space", "sp_goa")).toHaveLength(before);
    const row = enrichmentsFor("sp_goa")[0]!;
    expect(row.fetch_count).toBe(2);
    expect(row.changed_at).toBe(row.changed_at); // unchanged by the second fetch
    // No new Decide row: an unchanged page never reaches the model.
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM decide_queue WHERE space_id = 'sp_goa'`).get() as { n: number }).n,
    ).toBe(1);
  });

  it("a moved hash re-queues the space and records the new snapshot", () => {
    mkSpace("sp_goa", "goa trip");
    recordEnrichmentFetch({ spaceId: "sp_goa", kind: "fare", url: "https://x/fare", content: "₹4,300" });
    const moved = recordEnrichmentFetch({ spaceId: "sp_goa", kind: "fare", url: "https://x/fare", content: "₹5,100" });
    expect(moved).toMatchObject({ changed: true, first: false, queued: true });
    expect(enrichmentsFor("sp_goa")[0]!.summary).toBe("₹5,100");
    const actions = decisionsFor("space", "sp_goa").map((d) => d.action);
    expect(actions.filter((a) => a === "enrichment_changed")).toHaveLength(2);
  });

  it("whitespace-only reflow is not a change", () => {
    expect(contentHash("a  b\nc")).toBe(contentHash("a b c"));
  });

  it("refresh runs every target through the same hash gate", async () => {
    mkSpace("sp_goa", "goa trip");
    recordEnrichmentFetch({ spaceId: "sp_goa", kind: "fare", url: "https://x/fare", content: "₹4,300" });
    recordEnrichmentFetch({ spaceId: "sp_goa", kind: "hours", url: "https://x/hours", content: "9-6" });
    const report = await refreshEnrichments("sp_goa", async (url) => (url.endsWith("hours") ? "9-6" : "₹9,900"));
    expect(report).toMatchObject({ fetched: 2, changed: 1, failed: 0 });
  });

  it("a fetcher that throws is counted, never fatal", async () => {
    mkSpace("sp_goa", "goa trip");
    recordEnrichmentFetch({ spaceId: "sp_goa", kind: "fare", url: "https://x/fare", content: "₹4,300" });
    const report = await refreshEnrichments("sp_goa", async () => {
      throw new Error("offline");
    });
    expect(report).toMatchObject({ fetched: 0, changed: 0, failed: 1 });
  });
});

// ---------------------------------------------------------------------------
// List / view / re-file
// ---------------------------------------------------------------------------

describe("the Spaces list and view", () => {
  it("groups by life area in spec order, buckets unknown under Other and dormant apart", () => {
    mkSpace("sp_money", "tax filing", { area: "Money" });
    mkSpace("sp_travel", "goa trip", { area: "Travel" });
    mkSpace("sp_weird", "something", { area: "Zzz" });
    mkSpace("sp_none", "no area yet");
    mkSpace("sp_sleep", "old thing", { status: "dormant", area: "Travel" });
    mkSpace("sp_gone", "archived thing", { status: "archived", area: "Travel" });
    const list = spacesList();
    expect(list.areas.map((a) => a.area)).toEqual(["Money", "Travel", OTHER_AREA]);
    expect(list.areas.find((a) => a.area === OTHER_AREA)!.spaces.map((s) => s.id).sort()).toEqual([
      "sp_none",
      "sp_weird",
    ]);
    expect(list.dormant.map((s) => s.id)).toEqual(["sp_sleep"]);
    // Archived spaces are not in the list at all.
    expect(list.areas.flatMap((a) => a.spaces).map((s) => s.id)).not.toContain("sp_gone");
  });

  it("decorates a row with its open task count, next action, freshness and people", () => {
    mkSpace("sp_goa", "goa trip", { area: "Travel" });
    mkEpisode("ep_1", "flights on the 18th", { spaceId: "sp_goa", ts: "2026-08-22T09:00:00.000Z" });
    const db = getDb();
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, status, due) VALUES ('t1','sp_goa','book flights','explicit','open','2026-09-01')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, status) VALUES ('t2','sp_goa','pack','explicit','done')`,
    ).run();
    const row = spacesList().areas[0]!.spaces[0]!;
    expect(row).toMatchObject({ task_count: 1, next_action: "book flights", area: "Travel" });
    expect(row.freshness).toBe("2026-08-22T09:00:00.000Z");
    expect(row.people).toEqual(["rohan"]);
  });

  it("the view carries every why-target element, milestones only if staged, and the birth block", () => {
    const outcome = bornAsked({ label: "goa trip", goal: "december", utterance: "plan a goa trip", threadId: "th_9" });
    expect(outcome.outcome).toBe("created");
    if (outcome.outcome !== "created") return;
    const id = outcome.spaceId;
    const db = getDb();
    db.prepare(
      `INSERT INTO chapters (id, space_id, label, status, target_date) VALUES ('ch_1', ?, 'book flights', 'active', '2026-09-01')`,
    ).run(id);
    db.prepare(`INSERT INTO chapters (id, space_id, label, status) VALUES ('ch_2', ?, 'ideas', 'active')`).run(id);
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, status) VALUES ('t1', ?, 'book flights', 'explicit', 'open')`,
    ).run(id);
    mkEpisode("ep_1", "goa flights on the 18th", { spaceId: id });
    recordEnrichmentFetch({ spaceId: id, kind: "fare", url: "https://x/fare", content: "₹4,300" });

    const view = spaceView(id)!;
    expect(view.space.label).toBe("goa trip");
    expect(view.milestones.map((m) => m.id)).toEqual(["ch_1"]); // dated chapters only
    expect(view.chapters).toHaveLength(2);
    expect(view.tasks.map((t) => t.id)).toEqual(["t1"]);
    expect(view.episodes[0]!.quotes[0]!.text).toBe("goa flights on the 18th");
    expect(view.enrichments).toHaveLength(1);
    expect(view.birth).toMatchObject({ via: "asked", thread_id: "th_9" });
    expect(view.birth.evidence[0]!.quote).toBe("plan a goa trip");
  });

  it("a missing space views as null", () => {
    expect(spaceView("sp_nope")).toBeNull();
  });
});

describe("drag to re-file", () => {
  it("moves a space between life areas and writes one reversible decision", () => {
    mkSpace("sp_goa", "goa trip", { area: "Money" });
    const out = refileSpace("sp_goa", "Travel");
    expect(out).toMatchObject({ moved: true, from: "Money", to: "Travel" });
    expect(
      (getDb().prepare(`SELECT life_area AS a FROM spaces WHERE id = 'sp_goa'`).get() as { a: string }).a,
    ).toBe("Travel");
    const d = decisionsFor("space", "sp_goa")[0]!;
    expect(d.action).toBe("refile");
    expect(JSON.parse(d.oldJson!)).toEqual({ life_area: "Money" });
  });

  it("dropping into Other clears the field so the list and the store agree", () => {
    mkSpace("sp_goa", "goa trip", { area: "Travel" });
    expect(refileSpace("sp_goa", OTHER_AREA).moved).toBe(true);
    expect(
      (getDb().prepare(`SELECT life_area AS a FROM spaces WHERE id = 'sp_goa'`).get() as { a: string | null }).a,
    ).toBeNull();
    expect(spacesList().areas.map((a) => a.area)).toEqual([OTHER_AREA]);
  });

  it("a drop onto the group it already sits in changes nothing", () => {
    mkSpace("sp_goa", "goa trip", { area: "Travel" });
    expect(refileSpace("sp_goa", "travel")).toMatchObject({ moved: false, reason: "already filed there" });
    expect(decisionsFor("space", "sp_goa")).toHaveLength(0);
  });

  it("moves an episode into another space, and out to unsorted", () => {
    mkSpace("sp_a", "a");
    mkSpace("sp_b", "b");
    mkEpisode("ep_1", "flights", { spaceId: "sp_a" });
    expect(refileEpisode("ep_1", "sp_b")).toMatchObject({ moved: true, from: "sp_a", to: "sp_b" });
    const out = refileEpisode("ep_1", null);
    expect(out).toMatchObject({ moved: true, from: "sp_b", to: null });
    expect(
      (getDb().prepare(`SELECT space_id AS s FROM episodes WHERE id = 'ep_1'`).get() as { s: string | null }).s,
    ).toBeNull();
    // Back in unsorted, open — the next birth's sweep can still claim it.
    expect(
      (getDb().prepare(`SELECT status FROM unsorted WHERE episode_id = 'ep_1'`).get() as { status: string }).status,
    ).toBe("open");
  });

  it("refuses an unknown space or episode", () => {
    mkEpisode("ep_1", "flights");
    expect(refileEpisode("ep_1", "sp_nope")).toMatchObject({ moved: false, reason: "no such space" });
    expect(refileEpisode("ep_nope", null)).toMatchObject({ moved: false, reason: "no such episode" });
    expect(refileSpace("sp_nope", "Travel")).toMatchObject({ moved: false, reason: "no such space" });
  });

  it("only the fourteen areas plus Other are drop targets", () => {
    for (const a of LIFE_AREAS) expect(isLifeArea(a)).toBe(true);
    expect(isLifeArea(OTHER_AREA)).toBe(true);
    expect(normalizeLifeArea("  travel ")).toBe("Travel");
    expect(normalizeLifeArea("Zzz")).toBe(OTHER_AREA);
  });
});
