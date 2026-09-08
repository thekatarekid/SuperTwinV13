// ===========================================================================
// The §7.3 fallback — the merged pack, two calls (V6 P1 S4.4). Zero model
// calls: one stub provider answers all three calls of a tick and is asked what
// it was sent.
//
// THE FALLBACK IS NO LONGER THE DEFAULT (R1). The S4 ship gate's item 1 went
// green at the S4 release and again at the S6 graduation sweep, and S6 made
// orient.v7 / critic.v5 the shipped pair — so `DEFAULT_LIVE_MODE` is "merged"
// and production spends ONE live.v1 per bundle. What §7.3 promises is a
// fallback that still WORKS, not one that is switched on, so this file pins
// `SUPERTWIN_PROMPT_LIVE=two-call` for its own cases and keeps proving the
// two-call lane end to end. If an ORIENT re-measure ever regresses, flipping
// back is one env var, and this suite is the evidence that the var still
// leads somewhere.
//
// What has to be true for the fallback to be worth taking:
//
//   ONE PACK          both calls read the same `packed.user`. "Keep the
//                     merged pack" is the half of §7.3 that is not a
//                     regression guard — it is the S3.2 work we keep.
//   CALL 1 IS ORIENT  byte for byte the call the ORIENT golden set scores:
//                     the active orient prompt, the bare pack, no MODE line.
//                     If it were anything else, a green re-measure would say
//                     nothing about what production runs.
//   CALL 2 IS AFTER   the decide call happens after the commit, so its
//                     [UNDERSTANDING] block names committed episodes and real
//                     space ids — and a decide that fails outright cannot
//                     cost the tick anything already written.
//   THE LANE RULE     history still makes ONE call and never a decide call
//                     (LIV-02: `assist_from_history` = 0 by construction).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { collectTick, type DeltaBundle } from "../scheduler/v6/bundle.js";
import { ResourcePool } from "../providers/pool.js";
import type { Usage } from "../providers/types.js";
import {
  activeCriticPrompt,
  activeLiveMode,
  activeOrientPrompt,
  DEFAULT_LIVE_MODE,
  LIVE_PROMPT_ENV,
  LIVE_PROMPT_TWO_CALL,
} from "../prompts/versions.js";
import { LIVE_DECIDE_V1 } from "../prompts/live-decide.v1.js";
import { resetStableSystemPromptsForTests, type JsonPassDeps } from "./llm.js";
import { parseLiveDecideAnswer, renderUnderstandingBlock, runLiveUnderstanding } from "./live.js";
import { runBrainTick } from "./consumer.js";
import { providerV2TestDouble as brainTestProvider, providerRequestText } from "../providers/test-support.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-two-call-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  // The fallback is a mode, not the default, since R1 — select it explicitly.
  process.env[LIVE_PROMPT_ENV] = LIVE_PROMPT_TWO_CALL;
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  getDb().prepare(`INSERT INTO entities (id, type, canonical, provisional) VALUES ('ent_rohan', 'person', 'Rohan Mehta', 0)`).run();
  getDb()
    .prepare(`INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm) VALUES ('ei_rohan', 'ent_rohan', 'wa', 'handle', 'contact:rohan')`)
    .run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env[LIVE_PROMPT_ENV];
  rmSync(tmpDir, { recursive: true, force: true });
});

const T0 = Date.parse("2026-08-28T19:40:00.000Z");

function waMessage(i: number, text: string, origin: EventEnvelope["origin"] = "live"): EventEnvelope {
  return {
    ts: new Date(T0 + i * 60_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin,
    streamKey: "goa-gang@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text, external_id: `x${i}` },
  };
}

function seedBundle(texts: string[], origin: EventEnvelope["origin"] = "live"): DeltaBundle {
  appendEvents(texts.map((t, i) => waMessage(i + 1, t, origin)));
  const bundle = collectTick(T0 + 3_600_000).bundles.find((b) => b.streamKey === "goa-gang@g.us");
  if (!bundle) throw new Error("no bundle");
  return bundle;
}

interface Sent {
  /** Pass id inferred from the exact in-memory instruction bytes. */
  pass: string;
  user: string;
}

/** Records every call, answers each with the canned text for its position. */
function recordingDeps(answers: string[]): JsonPassDeps & { sent: Sent[] } {
  const sent: Sent[] = [];
  const provider = brainTestProvider(async (opts) => {
      const orient = activeOrientPrompt();
      const critic = activeCriticPrompt();
      const pass = opts.instructions === orient.system
        ? orient.pass
        : opts.instructions === critic.system
          ? critic.pass
          : opts.instructions === LIVE_DECIDE_V1.system
            ? LIVE_DECIDE_V1.pass
            : "unknown";
      sent.push({ pass, user: providerRequestText(opts) });
      const usage: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };
      opts.onEvent({ type: "delta", text: answers[sent.length - 1] ?? "{}" });
      opts.onEvent({ type: "done", continuation: null, usage });
      return { continuation: null, usage, freshFallback: false, status: "ok" as const };
  });
  return {
    provider,
    pool: new ResourcePool({ now: () => 0, sleep: async () => {} }),
    recordRun: () => "run_stub",
    quarantine: () => {},
    sent,
  };
}

const UNDERSTANDING = JSON.stringify({
  episodes: [
    {
      action: "new",
      events: ["e1"],
      summary: "Dates 18-21 Dec agreed",
      evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
      confidence: 0.93,
    },
  ],
  proposals: [],
  unsorted: [],
  questions: [],
});
const CRITIC = JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] });
const DECIDE = JSON.stringify({
  decide: {
    tasks: [],
    closures: [],
    schedules: [],
    prepared: [
      {
        kind: "needs_you",
        intent: "Lock the Goa dates",
        intent_confidence: 0.92,
        action: "question",
        urgency: "today",
        deadline_at: null,
        inputs: {},
        grounded_in: ["e1"],
        reasoning: "the group is waiting on a yes",
      },
    ],
  },
});

describe("the live lane spends two calls over one pack", () => {
  it("is REACHABLE but not the default — §7.3 keeps the capability, R1 removed the switch", () => {
    // The two halves of the promise, stated where they can both be read: what
    // ships is one merged call, and the fallback is still one env var away.
    expect(DEFAULT_LIVE_MODE).toBe("merged");
    expect(activeLiveMode()).toBe("two-call"); // because beforeEach selected it
    const saved = process.env[LIVE_PROMPT_ENV];
    try {
      delete process.env[LIVE_PROMPT_ENV];
      expect(activeLiveMode()).toBe("merged");
    } finally {
      process.env[LIVE_PROMPT_ENV] = saved!;
    }
  });

  it("orient, critic, decide — in that order, on the same packed user block", async () => {
    const bundle = seedBundle(["lets lock goa 18-21 dec"]);
    const deps = recordingDeps([UNDERSTANDING, CRITIC, DECIDE]);
    const report = await runBrainTick(bundle, deps);

    expect(report.status).toBe("committed");
    expect(deps.sent).toHaveLength(3);
    const [first, critic, decide] = deps.sent;

    // Call 1 IS the orient call: the scored prompt, the bare pack — not
    // live.v1, whose understanding half no golden run has ever measured. The
    // literal moved with the S6 default flip (orient.v6 -> orient.v7); the
    // line above is the invariant, this one is the statement of which pass
    // that resolves to today.
    expect(first.pass).toBe(activeOrientPrompt().pass);
    expect(first.pass).toBe("orient.v7");
    expect(first.user.startsWith("MODE:")).toBe(false);
    // Call 2 is the critic (it is handed the tick's writes, not the pack).
    expect(critic.user).toContain("\n[DECISIONS]\n");
    // Call 3 is the decide half, on live-decide.v1.
    expect(decide.pass).toBe(LIVE_DECIDE_V1.pass);
    expect(decide.user.startsWith("MODE: live-decide")).toBe(true);

    // ONE PACK: every block call 1 read, call 3 reads too.
    for (const block of ["[NOW]", "[BUNDLE]"]) {
      expect(first.user, `call 1 pack is missing ${block}`).toContain(block);
      expect(decide.user, `call 3 pack is missing ${block}`).toContain(block);
    }
    expect(decide.user).toContain(first.user.trim());

    // …and the decide call knows what the commit just wrote.
    const episodeId = report.commit!.committedEpisodes[0]!.episodeId;
    expect(decide.user).toContain("[UNDERSTANDING]");
    expect(decide.user).toContain(episodeId);

    // The decide half landed: one prepared action, grounded in this flush.
    expect(report.live?.prepared).toMatchObject({ persisted: 1, cards: 1, droppedUngrounded: 0 });
  });

  it("history makes ONE call and never a decide call (LIV-02 by construction)", async () => {
    const bundle = seedBundle(["ye purani baat hai"], "backfill");
    expect(bundle.lane).toBe("history");
    const deps = recordingDeps([UNDERSTANDING, CRITIC, DECIDE]);
    const report = await runBrainTick(bundle, deps);
    expect(report.live).toBeUndefined();
    // Orient + Critic. Nothing asked for a decide, so nothing could nudge.
    expect(deps.sent).toHaveLength(2);
    expect(deps.sent.every((s) => s.pass !== LIVE_DECIDE_V1.pass)).toBe(true);
  });

  it("a decide call that answers nothing usable costs the commit nothing", async () => {
    const bundle = seedBundle(["lets lock goa 18-21 dec"]);
    const deps = recordingDeps([UNDERSTANDING, CRITIC, "{}"]);
    const report = await runBrainTick(bundle, deps);
    expect(report.status).toBe("committed");
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM episodes`).get()).toEqual({ n: 1 });
    expect(report.live?.decide.tasksCreated).toBe(0);
    expect(report.live?.prepared.persisted).toBe(0);
    // …and it never bought a repair round for the decide section.
    expect(deps.sent).toHaveLength(3);
  });

  it("a decide the understanding call volunteers is ignored — call 2 owns that section", async () => {
    const bundle = seedBundle(["lets lock goa 18-21 dec"]);
    const merged = JSON.stringify({ understanding: JSON.parse(UNDERSTANDING), decide: JSON.parse(DECIDE).decide });
    const run = await runLiveUnderstanding(bundle, recordingDeps([merged]));
    expect(run.mode).toBe("two-call");
    expect(run.live?.understanding?.episodes).toHaveLength(1);
    expect(run.live?.decide).toBeUndefined();
    expect(run.live?.decideError).toBeUndefined();
  });
});

describe("parsing call 2's answer", () => {
  const opts = { lane: "live" as const };

  it('takes {"decide": {…}} and a bare decide object alike', () => {
    expect(parseLiveDecideAnswer(JSON.parse(DECIDE), opts).decide?.prepared).toHaveLength(1);
    expect(parseLiveDecideAnswer(JSON.parse(DECIDE).decide, opts).decide?.prepared).toHaveLength(1);
  });

  it("a present-but-broken decide is an error, not an empty decide (LIV-04)", () => {
    const out = parseLiveDecideAnswer({ decide: "sorry — {tasks: [" }, opts);
    expect(out.decide).toBeUndefined();
    expect(out.decideError).toMatch(/not an object/);
  });

  it("an answer with no decide section at all says so — and never repairs", () => {
    expect(parseLiveDecideAnswer({}, opts).decideError).toMatch(/missing/);
    expect(parseLiveDecideAnswer({ episodes: [] }, opts).decideError).toMatch(/missing/);
  });

  it("only a non-object earns the runner's one repair round", () => {
    expect(() => parseLiveDecideAnswer("sorry", opts)).toThrow(/one JSON object/);
    expect(() => parseLiveDecideAnswer([1, 2], opts)).toThrow(/one JSON object/);
  });

  it("insufficient context decides nothing, whatever the model said", () => {
    const out = parseLiveDecideAnswer(JSON.parse(DECIDE), { lane: "live", insufficientContext: true });
    expect(out.decide).toMatchObject({ tasks: [], closures: [], schedules: [], prepared: [] });
  });

  it("history discards prepared actions even here (the lane rule is code)", () => {
    const out = parseLiveDecideAnswer(JSON.parse(DECIDE), { lane: "history" });
    expect(out.decide?.prepared).toEqual([]);
    expect(out.decide?.preparedDiscardedForLane).toBe(1);
  });
});

describe("the [UNDERSTANDING] block", () => {
  it("names committed episodes with their spaces when there is a commit", () => {
    const block = renderUnderstandingBlock(
      { episodes: [{ action: "new", events: ["e1"], summary: "Dates agreed", evidence: [], confidence: 0.9 }], proposals: [], unsorted: [], questions: [] },
      { committedEpisodes: [{ episodeId: "ep_1", spaceId: "sp_goa" }] },
    );
    expect(block).toContain("[UNDERSTANDING]");
    expect(block).toContain("episode ep_1 · space sp_goa · Dates agreed");
  });

  it("falls back to what was parsed when nothing committed, and says so when nothing was filed", () => {
    expect(
      renderUnderstandingBlock({ episodes: [], proposals: [], unsorted: [], questions: ["Who is Aarav?"] }, null),
    ).toContain("question · Who is Aarav?");
    expect(renderUnderstandingBlock(undefined, null)).toContain("nothing was filed");
  });
});
