// ===========================================================================
// Orient + Critic pass tests (build P1.3) — stubbed provider, no live calls.
//
// Covers: verbatim prompt cores, output validation, alias/range resolution,
// the full tick (pack → Orient → Critic → commit → mark), the propose-only
// guarantee, the 0.60–0.75 second_look band, Critic verdicts (reject /
// downgrade / flag_overlap → T2 queue), and decisions rows for every write.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, type DeltaBundle } from "../scheduler/dispatch.js";
import { ResourcePool } from "../providers/pool.js";
import type { Provider, Usage } from "../providers/types.js";
import { ORIENT_V1, ORIENT_V1_CORE } from "../prompts/orient.v1.js";
import { CRITIC_V1, CRITIC_V1_CORE } from "../prompts/critic.v1.js";
import { resetStableSystemPromptsForTests, type JsonPassDeps } from "./llm.js";
import { parseOrientOutput, resolveEventAliases } from "./orient.js";
import { parseCriticOutput, verdictFor } from "./critic.js";
import { runBrainTick } from "./consumer.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-orient-"));
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

function waMessage(i: number, text: string, actor = "contact:rohan"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "goa-gang@g.us",
    actor,
    roles: { sender: actor, audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `x${i}` },
  };
}

/** Provider stub: one canned answer per call, in order. */
function stubDeps(answers: string[]): JsonPassDeps & { calls: () => number; users: string[] } {
  const users: string[] = [];
  const provider: Provider = {
    id: "fake",
    cancel: () => true,
    async send(opts) {
      users.push(opts.message);
      const text = answers[users.length - 1] ?? "{}";
      opts.onEvent({ type: "delta", text });
      const usage: Usage = {
        inputTokens: 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 5,
      };
      opts.onEvent({ type: "done", sessionId: "s", usage });
      return { sessionId: "s", usage, freshFallback: false, status: "ok" as const };
    },
  };
  return {
    provider,
    pool: new ResourcePool({ now: () => 0, sleep: async () => {} }),
    recordRun: () => "run_stub",
    quarantine: () => {},
    calls: () => users.length,
    users,
  };
}

function seedBundle(texts: string[]): DeltaBundle {
  appendEvents(texts.map((t, i) => waMessage(i + 1, t)));
  const plan = collectTick(T0 + 3_600_000);
  const bundle = plan.bundles.find((b) => b.streamKey === "goa-gang@g.us");
  if (!bundle) throw new Error("no bundle");
  return bundle;
}

describe("prompt modules", () => {
  it("orient.v1 carries the spec §8.1 core verbatim", () => {
    expect(ORIENT_V1_CORE).toContain("You are SuperTwin's Orient pass.");
    expect(ORIENT_V1_CORE).toContain("A wrong merge destroys; a wrong split is repairable.");
    expect(ORIENT_V1_CORE).toContain("Age-band policy and mode (propose-only) are hard constraints.");
    expect(ORIENT_V1.system.startsWith(ORIENT_V1_CORE)).toBe(true);
    expect(ORIENT_V1.pass).toBe("orient.v1");
  });

  it("critic.v1 carries the spec §8.2 core verbatim", () => {
    expect(CRITIC_V1_CORE).toContain("You grade another pass's writes BEFORE commit.");
    expect(CRITIC_V1_CORE).toContain("flags don't block; they queue a Tier-2");
    expect(CRITIC_V1_CORE).toContain("fabrication is auto-reject.");
    expect(CRITIC_V1.system.startsWith(CRITIC_V1_CORE)).toBe(true);
  });
});

describe("parseOrientOutput", () => {
  it("accepts the spec's example shape", () => {
    const out = parseOrientOutput({
      episodes: [
        {
          action: "join",
          episode: "ep_412",
          events: ["e1", "e4-e11"],
          summary: "Dates 18-21 Dec agreed.",
          evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
          confidence: 0.93,
        },
      ],
      proposals: [],
      unsorted: [],
      questions: [],
    });
    expect(out.episodes[0].episode).toBe("ep_412");
    expect(out.episodes[0].confidence).toBe(0.93);
  });

  it("rejects a join without an episode id, and defaults confidence to 0.9", () => {
    expect(() =>
      parseOrientOutput({ episodes: [{ action: "join", events: ["e1"], summary: "s" }] }),
    ).toThrow(/"join" needs/);
    const out = parseOrientOutput({
      episodes: [{ action: "new", events: ["e1"], summary: "s" }],
    });
    expect(out.episodes[0].confidence).toBe(0.9);
  });
});

describe("resolveEventAliases", () => {
  it("expands ranges inclusively and drops unknown aliases", () => {
    const aliases = new Map([
      ["e1", "A"],
      ["e2", "B"],
      ["e3", "C"],
      ["e4", "D"],
    ]);
    expect(resolveEventAliases(["e1", "e3-e4"], aliases)).toEqual(["A", "C", "D"]);
    expect(resolveEventAliases(["e2-4"], aliases)).toEqual(["B", "C", "D"]);
    expect(resolveEventAliases(["e9"], aliases)).toEqual([]);
  });
});

describe("parseCriticOutput + verdictFor", () => {
  it("requires a reason on reject; silence commits", () => {
    expect(() => parseCriticOutput({ verdicts: [{ item: 1, verdict: "reject" }] })).toThrow(
      /needs a reason/,
    );
    const out = parseCriticOutput({
      verdicts: [{ item: 2, verdict: "flag_overlap", space_id: "sp_x" }],
    });
    expect(verdictFor(out, 1)).toEqual({ item: 1, verdict: "commit" });
    expect(verdictFor(out, 2).space_id).toBe("sp_x");
  });
});

describe("runBrainTick — full tick with stubbed provider", () => {
  it("commits episodes, creates spaces at the born-status, files unsorted, marks dispatched", async () => {
    const bundle = seedBundle([
      "guys lets lock goa 18-21 dec",
      "did anyone pay the diwali pool??",
      "random link btw",
    ]);
    const orientAnswer = JSON.stringify({
      episodes: [
        {
          action: "new",
          events: ["e1"],
          summary: "Dates 18-21 Dec agreed",
          evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
          confidence: 0.93,
        },
      ],
      proposals: [
        {
          label: "Goa trip in December",
          life_area: "Travel",
          goal: "18-21 Dec trip",
          episode_events: ["e2"],
          summary: "Trip planning kicked off",
          evidence: [{ event_ids: ["e2"], quote: "did anyone pay the diwali pool??" }],
          confidence: 0.8,
        },
      ],
      unsorted: [{ events: ["e3"], summary: "stray link", reason: "no goal evidence", confidence: 0.5 }],
      questions: ["Who is Aarav?"],
    });
    const criticAnswer = JSON.stringify({
      verdicts: [
        { item: 1, verdict: "commit" },
        { item: 2, verdict: "commit" },
      ],
    });
    const deps = stubDeps([orientAnswer, criticAnswer]);

    const report = await runBrainTick(bundle, deps);
    expect(report.status).toBe("committed");
    expect(deps.calls()).toBe(2); // one Orient, one Critic — no more

    const db = getDb();
    // Episodes committed with ranges.
    const eps = db.prepare(`SELECT id, state, space_id, summary FROM episodes`).all() as {
      id: string;
      state: string;
      space_id: string | null;
      summary: string;
    }[];
    expect(eps).toHaveLength(3); // new episode + proposal episode + unsorted episode
    // Auto-create (the default): the new space is born ACTIVE. The born-status
    // comes from proposedStatus() alone — never from the model — and flips to
    // 'proposed' only while the user has propose-only on (Settings › General).
    const spaces = db.prepare(`SELECT label, status FROM spaces`).all() as {
      label: string;
      status: string;
    }[];
    expect(spaces).toEqual([{ label: "Goa trip in December", status: "active" }]);
    // Unsorted row for e3.
    expect(db.prepare(`SELECT COUNT(*) AS n FROM unsorted`).get()).toEqual({ n: 1 });
    // Every derived-object change wrote a decisions row.
    const decisions = db
      .prepare(`SELECT target_kind, action FROM decisions ORDER BY created_at`)
      .all() as { target_kind: string; action: string }[];
    // Auto-create records a 'create'; propose-only would record a 'propose'.
    expect(decisions.some((d) => d.target_kind === "space" && d.action === "create")).toBe(true);
    expect(decisions.filter((d) => d.target_kind === "episode")).not.toHaveLength(0);
    // The bundle is marked dispatched (cursor moved, events stamped).
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM events WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`).get(),
    ).toEqual({ n: 0 });
    // Reduce intake: the proposal's space has a decide_queue row.
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM decide_queue`).get() as { n: number }).n,
    ).toBeGreaterThanOrEqual(1);
    expect(report.commit?.questions).toEqual(["Who is Aarav?"]);
  });

  it("attaches at 0.65 with a second_look; refuses the attach below 0.6", async () => {
    const bundle = seedBundle(["more goa planning", "unrelated chatter"]);
    getDb()
      .prepare(
        `INSERT INTO spaces (id, label, status, updated_at)
         VALUES ('sp_goa', 'Goa trip with Rohan in December', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    const orientAnswer = JSON.stringify({
      episodes: [
        // S3.1: every write needs verbatim evidence or the commit path rejects it.
        {
          action: "new",
          events: ["e1"],
          summary: "planning continues",
          space: "sp_goa",
          confidence: 0.65,
          evidence: [{ event_ids: ["e1"], quote: "more goa planning" }],
        },
        {
          action: "new",
          events: ["e2"],
          summary: "maybe related",
          space: "sp_goa",
          confidence: 0.5,
          evidence: [{ event_ids: ["e2"], quote: "unrelated chatter" }],
        },
      ],
      proposals: [],
      unsorted: [],
      questions: [],
    });
    const deps = stubDeps([orientAnswer, JSON.stringify({ verdicts: [] })]);
    await runBrainTick(bundle, deps);

    const db = getDb();
    const attached = db
      .prepare(`SELECT space_id FROM episodes ORDER BY first_ts`)
      .all() as { space_id: string | null }[];
    expect(attached[0].space_id).toBe("sp_goa"); // 0.65 attaches
    expect(attached[1].space_id).toBeNull(); // 0.5 does not
    const looks = db.prepare(`SELECT space_id, attach_confidence FROM second_look`).all();
    expect(looks).toEqual([{ space_id: "sp_goa", attach_confidence: 0.65 }]);
    // The refused attach landed in unsorted instead.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM unsorted`).get() as { n: number }).n).toBe(1);
  });

  it("critic reject drops the write; flag_overlap commits AND queues T2", async () => {
    const bundle = seedBundle(["msg one", "msg two"]);
    getDb()
      .prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_other', 'Existing overlap space', 'active')`)
      .run();
    const orientAnswer = JSON.stringify({
      episodes: [
        {
          action: "new",
          events: ["e1"],
          summary: "will be rejected",
          confidence: 0.9,
          evidence: [{ event_ids: ["e1"], quote: "msg one" }],
        },
      ],
      proposals: [
        {
          label: "Duplicate looking space",
          episode_events: ["e2"],
          summary: "overlaps sp_other",
          evidence: [{ event_ids: ["e2"], quote: "msg two" }],
          confidence: 0.85,
        },
      ],
      unsorted: [],
      questions: [],
    });
    const criticAnswer = JSON.stringify({
      verdicts: [
        { item: 1, verdict: "reject", reason: "evidence does not support it" },
        { item: 2, verdict: "flag_overlap", space_id: "sp_other" },
      ],
    });
    const deps = stubDeps([orientAnswer, criticAnswer]);
    const report = await runBrainTick(bundle, deps);

    const db = getDb();
    // The rejected episode never landed; the flagged proposal did.
    const eps = db.prepare(`SELECT summary FROM episodes`).all() as { summary: string }[];
    expect(eps.map((e) => e.summary)).toEqual(["overlaps sp_other"]);
    expect(report.commit?.rejected).toBe(1);
    // flag_overlap: committed at the born-status (active, under the default)
    // AND queued for T2 review immediately — the overlap is resolved by the
    // merge pass, reversibly, not by withholding the space from the user.
    expect(
      db.prepare(`SELECT status FROM spaces WHERE label = 'Duplicate looking space'`).get(),
    ).toEqual({ status: "active" });
    const t2 = db
      .prepare(`SELECT kind, overlap_space_id, status FROM t2_review_queue`)
      .all() as { kind: string; overlap_space_id: string | null; status: string }[];
    expect(t2).toEqual([{ kind: "flag_overlap", overlap_space_id: "sp_other", status: "pending" }]);
  });

  it("a quarantined Orient leaves the bundle unmarked for the orphan scan", async () => {
    const bundle = seedBundle(["please book the villa today"]);
    const deps = stubDeps(["not json", "still not json"]);
    const report = await runBrainTick(bundle, deps);
    expect(report.status).toBe("quarantined");
    const db = getDb();
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM events WHERE dispatched_at IS NULL AND stream_key IS NOT NULL`).get() as { n: number }).n,
    ).toBeGreaterThan(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM episodes`).get() as { n: number }).n).toBe(0);
  });
});
