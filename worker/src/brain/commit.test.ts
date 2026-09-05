// ===========================================================================
// Commit rewrite tests (V6 P1 S3.1, build §6.1) — CMT-01..05 deterministic,
// plus the code paths around them. No provider is reached: commitTick is
// driven directly with canned Orient/Critic output, and the one consumer
// test uses a stub provider (zero live model calls).
//
//   CMT-01  explicit membership  — episode_events rows == cited aliases, no ranges
//   CMT-02  one stream/episode   — S1+S2 in one item rejects alone; others commit
//   CMT-03  per-item salvage     — 5 items, 1 malformed → 4 commit; cursor on ids
//   CMT-04  evidence must resolve — non-verbatim quote is a REJECT, not a downgrade
//   CMT-05  coverage             — every alias in exactly one place, else flagged
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { episodeMemberIds, listDeadLetters } from "../db/v6core.js";
import { collectTick, markDispatchedEvents, type DeltaBundle } from "../scheduler/v6/bundle.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, Usage } from "../providers/types.js";
import { resetStableSystemPromptsForTests, type JsonPassDeps } from "./llm.js";
import { parseOrientOutput, type OrientOutput } from "./orient.js";
import type { CriticOutput } from "./critic.js";
import { commitTick, type CommitInput } from "./commit.js";
import { runBrainTick } from "./consumer.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-commit-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  // V6 S3.2: the sender resolves to a known person, so these worlds are not
  // thin-context (a bare stream + unresolved sender + tiny bundle would be
  // held one flush by the packer instead of reaching the stubbed model).
  getDb().prepare(`INSERT INTO entities (id, type, canonical, provisional) VALUES ('ent_rohan', 'person', 'Rohan Mehta', 0)`).run();
  getDb().prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES ('ei_rohan', 'ent_rohan', 'wa', 'handle', 'contact:rohan')`).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T19:40:00.000Z");
const S1 = "goa-gang@g.us";
const S2 = "family@g.us";

function wa(i: number, streamKey: string, text: string, actor = "contact:rohan"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey,
    actor,
    roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `${streamKey}:${i}` },
  };
}

interface World {
  bundle: DeltaBundle;
  aliases: Map<string, string>;
  streamAliases: Map<string, string>;
  /** alias → stream id */
  streamOf: Map<string, string>;
}

/**
 * Seed `[stream, text]` pairs in log order and build ONE bundle over all of
 * them (the S3 day-bundle shape: several streams, one call), aliased e1..eN
 * in log order with S1/S2 section tags.
 */
function seed(rows: Array<[string, string]>): World {
  appendEvents(rows.map(([s, t], i) => wa(i + 1, s, t)));
  const plan = collectTick(T0 + 3_600_000);
  const byKey = new Map(plan.bundles.map((b) => [b.streamKey, b]));
  const first = byKey.get(rows[0][0]);
  if (!first) throw new Error("no bundle");
  const events = plan.bundles.flatMap((b) => b.events).sort((a, b) => a.rowid - b.rowid);
  const bundle: DeltaBundle = { ...first, events };
  const aliases = new Map<string, string>();
  const streamOf = new Map<string, string>();
  const streamAliases = new Map<string, string>();
  const keys = [...new Set(rows.map(([s]) => s))];
  keys.forEach((k, i) => streamAliases.set(`S${i + 1}`, byKey.get(k)!.streamId));
  events.forEach((e, i) => {
    aliases.set(`e${i + 1}`, e.id);
    const owner = plan.bundles.find((b) => b.events.some((x) => x.id === e.id))!;
    streamOf.set(`e${i + 1}`, owner.streamId);
  });
  return { bundle, aliases, streamAliases, streamOf };
}

function orient(raw: Record<string, unknown>): OrientOutput {
  return parseOrientOutput({ episodes: [], proposals: [], unsorted: [], questions: [], ...raw });
}

const silent: CriticOutput = { verdicts: [] };

function commit(w: World, o: OrientOutput, critic: CriticOutput = silent, extra: Partial<CommitInput> = {}) {
  return commitTick({
    bundle: w.bundle,
    orient: o,
    critic,
    aliases: w.aliases,
    streamAliases: w.streamAliases,
    ...extra,
  });
}

function ep(events: string[], summary: string, quoteAlias: string, quote: string, more: Record<string, unknown> = {}) {
  return {
    action: "new",
    stream: "S1",
    events,
    summary,
    evidence: [{ event_ids: [quoteAlias], quote }],
    confidence: 0.9,
    ...more,
  };
}

function db() {
  return getDb();
}

function memberRows(): Array<{ episode_id: string; event_id: string | null; start_event_id: string; end_event_id: string }> {
  return db()
    .prepare(`SELECT episode_id, event_id, start_event_id, end_event_id FROM episode_events`)
    .all() as never;
}

// ---------------------------------------------------------------------------

describe("CMT-01 · explicit membership", () => {
  it("every committed episode has episode_events rows equal to its cited aliases; no rowid ranges", () => {
    const w = seed([
      [S1, "guys lets lock goa 18-21 dec"],
      [S1, "villa sol wale bol rahe advance aaj chahiye"],
      [S1, "kitna?"],
      [S1, "15k total, 5k each"],
      [S1, "random link btw"],
    ]);
    const o = orient({
      episodes: [
        ep(["e1"], "Dates 18-21 Dec agreed", "e1", "lets lock goa 18-21 dec"),
        ep(["e2-e4"], "Villa Sol advance: 15k, 5k each", "e4", "15k total, 5k each"),
      ],
      unsorted: [{ events: ["e5"], summary: "stray link", reason: "no goal", confidence: 0.5 }],
    });
    const r = commit(w, o);
    expect(r.rejected).toBe(0);
    expect(r.committedEpisodes).toHaveLength(3);

    const ids = (as: string[]) => as.map((a) => w.aliases.get(a)!);
    const [a, b, c] = r.committedEpisodes;
    expect(episodeMemberIds(a.episodeId)).toEqual(ids(["e1"]));
    expect(episodeMemberIds(b.episodeId)).toEqual(ids(["e2", "e3", "e4"]));
    expect(episodeMemberIds(c.episodeId)).toEqual(ids(["e5"]));

    // No ranges anywhere: every row is a range of one with event_id set.
    const rows = memberRows();
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.event_id).not.toBeNull();
      expect(row.start_event_id).toBe(row.event_id);
      expect(row.end_event_id).toBe(row.event_id);
    }
    // Every bundle event handled, nothing held, coverage clean.
    expect(r.handledEventIds).toHaveLength(5);
    expect(r.heldEventIds).toEqual([]);
    expect(r.coverage).toEqual({ uncovered: [], duplicated: [] });
  });

  it("a join adds membership rows to the existing episode and keeps its stream", () => {
    const w = seed([
      [S1, "advance discussion starts"],
      [S1, "advance by 5 pm today or they release it"],
    ]);
    const first = commit(w, orient({ episodes: [ep(["e1"], "advance discussion", "e1", "advance discussion starts")] }));
    const epId = first.committedEpisodes[0].episodeId;
    const second = commit(
      w,
      orient({
        episodes: [
          {
            action: "join",
            episode: epId,
            stream: "S1",
            events: ["e2"],
            summary: "advance due 5 pm",
            evidence: [{ event_ids: ["e2"], quote: "advance by 5 pm today" }],
            confidence: 0.95,
          },
        ],
      }),
    );
    expect(second.rejected).toBe(0);
    expect(second.committedEpisodes[0].episodeId).toBe(epId);
    expect(episodeMemberIds(epId)).toEqual([w.aliases.get("e1"), w.aliases.get("e2")]);
    const row = db().prepare(`SELECT stream_id, summary FROM episodes WHERE id = ?`).get(epId) as {
      stream_id: string;
      summary: string;
    };
    expect(row.stream_id).toBe(w.streamAliases.get("S1"));
    expect(row.summary).toBe("advance due 5 pm");
  });
});

describe("CMT-02 · one stream per episode", () => {
  it("an item citing S1 and S2 events rejects alone; the others commit with derived stream ids", () => {
    const w = seed([
      [S1, "villa sol advance aaj chahiye"],
      [S2, "pune wali ticket kal tak book kar do"],
      [S1, "5k each, monday tak pakka"],
      [S2, "haan aaj raat karta hoon"],
    ]);
    const o = orient({
      episodes: [
        // e1 (S1) + e2 (S2) in one episode — the model's tag says S1.
        ep(["e1", "e2"], "advance and tickets", "e1", "villa sol advance aaj chahiye"),
        ep(["e3"], "Karan pays 5k by Monday", "e3", "5k each, monday tak pakka"),
        ep(["e4"], "Aditya will book tonight", "e4", "haan aaj raat karta hoon", { stream: "S2" }),
      ],
    });
    const r = commit(w, o);
    expect(r.rejected).toBe(1);
    expect(r.rejections).toEqual([
      expect.objectContaining({ item: 1, kind: "episode", reason: "multi_stream" }),
    ]);
    expect(r.committedEpisodes).toHaveLength(2);
    // Derived from the events, not copied from the bundle.
    expect(r.committedEpisodes[0].streamId).toBe(w.streamAliases.get("S1"));
    expect(r.committedEpisodes[1].streamId).toBe(w.streamAliases.get("S2"));
    const stored = db()
      .prepare(`SELECT stream_id FROM episodes ORDER BY first_ts`)
      .all() as { stream_id: string }[];
    expect(stored.map((s) => s.stream_id)).toEqual([w.streamAliases.get("S1"), w.streamAliases.get("S2")]);
    // Whole-bundle quarantine is the wrong answer: e3/e4 handled, e1/e2 held.
    expect(r.heldEventIds).toEqual([w.aliases.get("e1"), w.aliases.get("e2")]);
    expect(r.handledEventIds).toEqual([w.aliases.get("e3"), w.aliases.get("e4")]);
  });

  it("a stream tag naming another section rejects (code enforces the model's tag)", () => {
    const w = seed([
      [S1, "villa sol advance aaj chahiye"],
      [S2, "pune wali ticket kal tak book kar do"],
    ]);
    const r = commit(
      w,
      orient({
        episodes: [
          ep(["e2"], "tickets", "e2", "pune wali ticket", { stream: "S1" }), // events are S2
          ep(["e1"], "advance", "e1", "villa sol advance", { stream: "S1" }),
        ],
      }),
    );
    expect(r.rejections.map((x) => [x.item, x.reason])).toEqual([[1, "stream_tag_mismatch"]]);
    expect(r.committedEpisodes).toHaveLength(1);
  });

  it("without section aliases the tag is advisory — the events alone decide", () => {
    const w = seed([[S1, "villa sol advance aaj chahiye"]]);
    const r = commit(w, orient({ episodes: [ep(["e1"], "advance", "e1", "villa sol advance", { stream: "S7" })] }), silent, {
      streamAliases: undefined,
    });
    expect(r.rejected).toBe(0);
    expect(r.committedEpisodes[0].streamId).toBe(w.streamAliases.get("S1"));
  });

  it("joining an episode on another stream rejects", () => {
    const w = seed([
      [S1, "villa sol advance aaj chahiye"],
      [S2, "pune wali ticket kal tak book kar do"],
    ]);
    const first = commit(w, orient({ episodes: [ep(["e1"], "advance", "e1", "villa sol advance")] }));
    const epId = first.committedEpisodes[0].episodeId;
    const r = commit(
      w,
      orient({
        episodes: [
          {
            action: "join",
            episode: epId,
            stream: "S2",
            events: ["e2"],
            summary: "tickets",
            evidence: [{ event_ids: ["e2"], quote: "pune wali ticket" }],
            confidence: 0.9,
          },
        ],
      }),
    );
    expect(r.rejections.map((x) => x.reason)).toEqual(["join_stream_mismatch"]);
    expect(episodeMemberIds(epId)).toEqual([w.aliases.get("e1")]);
  });

  it("an unsorted entry spanning two streams is repaired into one unsorted episode per stream", () => {
    const w = seed([
      [S1, "ok"],
      [S2, "👍"],
    ]);
    const r = commit(w, orient({ unsorted: [{ events: ["e1", "e2"], summary: "acks", reason: "no signal", confidence: 0.4 }] }));
    expect(r.rejected).toBe(0);
    expect(r.unsorted).toBe(2);
    expect(r.committedEpisodes.map((e) => e.streamId).sort()).toEqual(
      [w.streamAliases.get("S1"), w.streamAliases.get("S2")].sort(),
    );
  });
});

describe("CMT-03 · per-item salvage", () => {
  const texts: Array<[string, string]> = [
    [S1, "guys lets lock goa 18-21 dec"],
    [S1, "villa sol wale bol rahe advance aaj chahiye"],
    [S1, "main kar deta hoon, baad me collect"],
    [S1, "mera 5k monday tak pakka"],
    [S1, "rohan ka birthday 3 oct hai, plan?"],
  ];

  function fiveItems(): OrientOutput {
    return orient({
      episodes: [
        ep(["e1"], "dates agreed", "e1", "lets lock goa 18-21 dec"),
        ep(["e2"], "advance asked", "e2", "advance aaj chahiye"),
        // malformed: the quote is not in e3
        ep(["e3"], "Aditya pays now", "e3", "I have paid the full amount"),
        ep(["e4"], "Karan pays Monday", "e4", "monday tak pakka"),
        ep(["e5"], "Rohan's birthday plan", "e5", "birthday 3 oct"),
      ],
    });
  }

  it("5 episodes, 1 malformed → 4 commit; the cursor advances past only those 4's events", () => {
    const w = seed(texts);
    const r = commit(w, fiveItems());
    expect(r.committedEpisodes).toHaveLength(4);
    expect(r.rejected).toBe(1);
    expect(r.rejections[0]).toEqual(expect.objectContaining({ item: 3, reason: "evidence_not_verbatim" }));
    const e3 = w.aliases.get("e3")!;
    expect(r.heldEventIds).toEqual([e3]);
    expect(r.handledEventIds).toEqual(["e1", "e2", "e4", "e5"].map((a) => w.aliases.get(a)));

    // The consumer's mark: the four handled rows stamped, e3 not; the cursor
    // stops at e2 (everything below it is stamped), so e3 is re-collectable.
    const mark = markDispatchedEvents(w.bundle, r.handledEventIds, T0 + 3_700_000);
    expect(mark.stamped).toBe(4);
    const rowidOf = (a: string) => w.bundle.events.find((e) => e.id === w.aliases.get(a))!.rowid;
    expect(mark.cursorRowid).toBe(rowidOf("e2"));
    const cursor = db()
      .prepare(`SELECT cursor_rowid FROM streams WHERE id = ?`)
      .get(w.bundle.streamId) as { cursor_rowid: number };
    expect(cursor.cursor_rowid).toBe(rowidOf("e2"));
    const undispatched = db()
      .prepare(`SELECT id FROM events WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`)
      .all() as { id: string }[];
    expect(undispatched.map((u) => u.id)).toEqual([e3]);

    // Next tick: exactly e3 comes back, alone, on its stream.
    const next = collectTick(T0 + 7_200_000);
    expect(next.bundles).toHaveLength(1);
    expect(next.bundles[0].events.map((e) => e.id)).toEqual([e3]);
  });

  it("an item whose aliases resolve to nothing rejects with nothing held", () => {
    const w = seed([[S1, "hello"]]);
    const r = commit(w, orient({ episodes: [ep(["e9"], "ghost", "e9", "hello")] }));
    expect(r.rejections.map((x) => x.reason)).toEqual(["no_events"]);
    expect(r.heldEventIds).toEqual([]);
    // e1 was never named: uncovered, flagged, still handled.
    expect(r.coverage.uncovered).toEqual(["e1"]);
    expect(r.handledEventIds).toEqual([w.aliases.get("e1")]);
  });

  it("critic-rejected items hold their events too", () => {
    const w = seed([
      [S1, "msg one"],
      [S1, "msg two"],
    ]);
    const r = commit(
      w,
      orient({ episodes: [ep(["e1"], "one", "e1", "msg one"), ep(["e2"], "two", "e2", "msg two")] }),
      { verdicts: [{ item: 2, verdict: "reject", reason: "unsupported" }] },
    );
    expect(r.rejections).toEqual([expect.objectContaining({ item: 2, reason: "critic", detail: "unsupported" })]);
    expect(r.heldEventIds).toEqual([w.aliases.get("e2")]);
  });
});

describe("CMT-04 · evidence must resolve (hard)", () => {
  it("a quote that is not verbatim in the cited event is a REJECT, not a downgrade", () => {
    const w = seed([[S1, "thinking about booking the villa"]]);
    const r = commit(
      w,
      orient({ episodes: [ep(["e1"], "Villa booked", "e1", "booked the villa")] }),
      // Even a critic that would merely downgrade cannot soften a fabrication.
      { verdicts: [{ item: 1, verdict: "downgrade_to_unsorted", reason: "summary stronger than quote" }] },
    );
    expect(r.rejected).toBe(1);
    expect(r.downgraded).toBe(0);
    expect(r.rejections[0].reason).toBe("evidence_not_verbatim");
    expect(db().prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 0 });
    expect(db().prepare(`SELECT COUNT(*) AS n FROM unsorted`).get()).toEqual({ n: 0 });
    // fabricated_evidence = 0: nothing of it landed; the decision row says why.
    const dec = db()
      .prepare(`SELECT action, reason FROM decisions WHERE target_kind = 'episode'`)
      .all() as { action: string; reason: string }[];
    expect(dec).toEqual([{ action: "reject", reason: expect.stringContaining("evidence_not_verbatim") }]);
  });

  it("evidence must exist and must resolve to real ids", () => {
    const w = seed([[S1, "villa sol advance aaj chahiye"]]);
    const none = commit(w, orient({ episodes: [{ action: "new", events: ["e1"], summary: "x", evidence: [], confidence: 0.9 }] }));
    expect(none.rejections.map((x) => x.reason)).toEqual(["no_evidence"]);
    const ghost = commit(
      w,
      orient({ episodes: [{ action: "new", events: ["e1"], summary: "x", evidence: [{ event_ids: ["e42"], quote: "villa sol" }], confidence: 0.9 }] }),
    );
    expect(ghost.rejections.map((x) => x.reason)).toEqual(["evidence_unresolved"]);
    // A proposal is held to the same bar.
    const prop = commit(
      w,
      orient({
        proposals: [
          { label: "Goa trip in December", episode_events: ["e1"], summary: "trip", evidence: [{ event_ids: ["e1"], quote: "flights booked" }], confidence: 0.9 },
        ],
      }),
    );
    expect(prop.rejections).toEqual([expect.objectContaining({ kind: "proposal", reason: "evidence_not_verbatim" })]);
    expect(db().prepare(`SELECT COUNT(*) AS n FROM spaces`).get()).toEqual({ n: 0 });
  });

  it("verbatim tolerates whitespace, outer quotes and NFC — nothing else", () => {
    const w = seed([[S1, "Villa Sol – Anjuna · ₹5,400/night · pool"]]);
    const ok = commit(w, orient({ episodes: [ep(["e1"], "compare", "e1", "“₹5,400/night   · pool”")] }));
    expect(ok.rejected).toBe(0);
    const bad = commit(w, orient({ episodes: [ep(["e1"], "compare", "e1", "₹5,400 per night")] }));
    expect(bad.rejections.map((x) => x.reason)).toEqual(["evidence_not_verbatim"]);
    const cased = commit(w, orient({ episodes: [ep(["e1"], "compare", "e1", "villa sol – anjuna")] }));
    expect(cased.rejections.map((x) => x.reason)).toEqual(["evidence_not_verbatim"]);
  });
});

describe("CMT-05 · coverage", () => {
  it("every alias in exactly one of episodes/unsorted → clean; a miss or a double is flagged mechanically", () => {
    const w = seed([
      [S1, "guys lets lock goa 18-21 dec"],
      [S1, "did anyone pay the diwali pool??"],
      [S1, "random link btw"],
      [S1, "ok"],
    ]);
    const clean = commit(
      w,
      orient({
        episodes: [ep(["e1"], "dates", "e1", "lets lock goa"), ep(["e2"], "pool", "e2", "diwali pool")],
        unsorted: [{ events: ["e3", "e4"], summary: "noise", confidence: 0.3 }],
      }),
    );
    expect(clean.coverage).toEqual({ uncovered: [], duplicated: [] });
    expect(db().prepare(`SELECT COUNT(*) AS n FROM decisions WHERE action = 'coverage_flag'`).get()).toEqual({ n: 0 });
  });

  it("flags the uncovered alias and the double placement; the first placement wins", () => {
    const w = seed([
      [S1, "guys lets lock goa 18-21 dec"],
      [S1, "did anyone pay the diwali pool??"],
      [S1, "random link btw"],
    ]);
    const r = commit(
      w,
      orient({
        episodes: [ep(["e1", "e2"], "dates + pool", "e1", "lets lock goa")],
        // e2 again — already placed above; e3 never named.
        unsorted: [{ events: ["e2"], summary: "pool?", confidence: 0.3 }],
      }),
    );
    expect(r.coverage).toEqual({ uncovered: ["e3"], duplicated: ["e2"] });
    expect(r.committedEpisodes).toHaveLength(1);
    expect(episodeMemberIds(r.committedEpisodes[0].episodeId)).toEqual([w.aliases.get("e1"), w.aliases.get("e2")]);
    expect(r.unsorted).toBe(0);
    const flag = db()
      .prepare(`SELECT target_kind, new_json FROM decisions WHERE action = 'coverage_flag'`)
      .get() as { target_kind: string; new_json: string };
    expect(flag.target_kind).toBe("bundle");
    expect(JSON.parse(flag.new_json)).toEqual({ uncovered: ["e3"], duplicated: ["e2"] });
    // The uncovered row is handled (stamped), never re-asked; nothing held.
    expect(r.handledEventIds).toHaveLength(3);
    expect(r.heldEventIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The consumer end to end (stub provider; zero live calls)
// ---------------------------------------------------------------------------

function stubDeps(answers: string[]): JsonPassDeps & { calls: () => number } {
  let n = 0;
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      const text = answers[n++] ?? "{}";
      opts.onEvent({ type: "delta", text });
      const usage: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  return {
    provider,
    pool: new ResourcePool({ now: () => 0, sleep: async () => {} }),
    recordRun: () => "run_stub",
    quarantine: () => {},
    calls: () => n,
  };
}

describe("runBrainTick · salvage through the consumer", () => {
  it("held rows stay undispatched and are re-collected; three strikes dead-letter and stamp them", async () => {
    const w = seed([
      [S1, "guys lets lock goa 18-21 dec"],
      [S1, "villa sol wale bol rahe advance aaj chahiye"],
    ]);
    const good = ep(["e1"], "dates", "e1", "lets lock goa 18-21 dec");
    const bad = ep(["e2"], "advance paid", "e2", "advance paid in full");
    const answer = JSON.stringify({ episodes: [good, bad], proposals: [], unsorted: [], questions: [] });
    const critic = JSON.stringify({ verdicts: [] });

    const first = await runBrainTick(w.bundle, stubDeps([answer, critic]));
    expect(first.status).toBe("committed");
    expect(first.commit?.rejected).toBe(1);
    const e2 = w.aliases.get("e2")!;
    let left = db().prepare(`SELECT id FROM events WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`).all() as { id: string }[];
    expect(left.map((x) => x.id)).toEqual([e2]);

    // Strikes 2 and 3 on the re-collected single-event bundle.
    const badOnly = JSON.stringify({
      episodes: [ep(["e1"], "advance paid", "e1", "advance paid in full")],
      proposals: [],
      unsorted: [],
      questions: [],
    });
    for (let strike = 2; strike <= 3; strike++) {
      const plan = collectTick(T0 + 3_600_000 * strike);
      expect(plan.bundles).toHaveLength(1);
      expect(plan.bundles[0].events.map((e) => e.id)).toEqual([e2]);
      const deps = stubDeps([badOnly, critic]);
      const report = await runBrainTick(plan.bundles[0], deps);
      expect(deps.calls()).toBe(2);
      expect(report.commit?.rejected).toBe(1);
      left = db().prepare(`SELECT id FROM events WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`).all() as { id: string }[];
      if (strike < 3) expect(left.map((x) => x.id)).toEqual([e2]);
      else expect(left).toEqual([]); // dead-lettered and stamped: it stops cycling
    }
    const dead = listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].lastError).toContain("evidence_not_verbatim");
    // Nothing of the fabricated item ever landed.
    expect(db().prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 1 });
  });
});
