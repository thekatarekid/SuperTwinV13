// ===========================================================================
// THE S4 SHIP GATE — Build V6 P1 §7.3. "All four must hold before `assist/`
// is deleted."
//
//   1. ORIENT golden set >= baseline
//   2. AST parity on the re-homed LIV cases
//   3. CROSS-N50 — one space, two episodes, exactly one nudge citing both
//      sources
//   4. A history bundle containing a stale "pay by 5 pm" emits ZERO prepared
//      actions
//
// Items 2, 3 and 4 are decidable without a model and are decided here (3 in
// full in executors/cross.test.ts; this file asserts it is wired and named).
// Item 1 needs the real passes and is measured by the eval CLI:
//
//   SUPERTWIN_PROMPT_ORIENT=v7 SUPERTWIN_PROMPT_CRITIC=v5 \
//     npm run eval -- --cat TOP --compare-baseline
//
// MEASURED AT THE S4 GATE (2026-09-06, orient.v7 + critic.v5, 21 live calls
// per run):
//
//   run 1   TOP 9/10   regressed: TOP-08 (critic rejected the birthday
//                      proposal — "e2 was not in the [BUNDLE]", a harness gap
//                      this commit closes in executors/orient.ts)
//   TOP-08 alone       pass, with that gap closed (3 calls)
//   run 2   TOP 8/10   regressed: TOP-06 (judge: split point ambiguous),
//                      TOP-08 (judge: a proposal is not an episode)
//
// The frozen bar is 100% (recorded in S3.5 from ONE 21-call run under the same
// v7/v5 pair), so ITEM 1 DOES NOT HOLD and the §7.3 fallback applies: keep the
// merged pack, do NOT flip the defaults, do NOT delete `assist/`. The tests
// below assert that fallback state, so nothing downstream can proceed as if
// the gate were green.
//
// S4.4 ENGAGED THE OTHER HALF of that fallback — "make two calls". The live
// lane no longer runs the merged one-call `live.v1` by default: it packs once
// (S3.2, unchanged) and spends the frozen orient prompt on understanding, then
// `live-decide.v1` on the decide half. So the only understanding prompt
// production runs is the one the ORIENT golden set measures, and nothing the
// twin files rides on text item 1 could not clear.
//
// THE CHECKLIST TO FLIP, when a re-measure clears the bar:
//   1. `DEFAULT_ORIENT_VERSION` / `DEFAULT_CRITIC_VERSION` → v7 / v5
//   2. `DEFAULT_LIVE_MODE` → "merged"
//   3. delete `assist/{watcher,evaluator,gate}.ts` and this file
//
// Zero model calls in this file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { setConsentGateMode } from "../db/consent-gate.js";
import { listPreparedActions } from "../brain/live.js";
import { ORIENT_V7_PACK, ORIENT_V7_SCHEMA } from "../prompts/orient.v7.js";
import { LIVE_V1, LIVE_V1_DECIDE_SCHEMA } from "../prompts/live.v1.js";
import { LIVE_DECIDE_V1 } from "../prompts/live-decide.v1.js";
import {
  activeCriticPrompt,
  activeLiveMode,
  activeLivePrompt,
  activeOrientPrompt,
  CRITIC_VERSIONS,
  DEFAULT_CRITIC_VERSION,
  DEFAULT_LIVE_MODE,
  DEFAULT_LIVE_VERSION,
  DEFAULT_ORIENT_VERSION,
  LIVE_PROMPT_ENV,
  LIVE_PROMPT_OFF,
  LIVE_PROMPT_TWO_CALL,
  LIVE_VERSIONS,
  ORIENT_VERSIONS,
  PROMPT_VERSION_ENV,
} from "../prompts/versions.js";
import { DEFAULT_INTENT_FLOOR } from "../settings/p1-settings.js";
import { DEFAULT_NUDGE_INTENT_FLOOR, nudgeThresholds, nudgeVerdict } from "../surfaces/nudge-verdict.js";
import { loadFixture } from "./fixtures.js";
import { astParityGaps } from "./parity.js";
import { cleanupLiv, runLivCase, type LivRun } from "./executors/liv.js";

const FIX = join(import.meta.dirname, "../../../evals/v13");
const corpusIds = (): string[] =>
  readdirSync(FIX)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

// ---------------------------------------------------------------------------
// Item 1 — ORIENT golden >= baseline (the code half)
// ---------------------------------------------------------------------------

describe("§7.3 item 1 — ORIENT golden set (measured red; the fallback holds)", () => {
  it("the frozen defaults are NOT flipped — the golden set has not cleared the bar", () => {
    // Build §2.1: "orient.v6 and critic.v4 stay as the frozen baseline until
    // the S4 gate". The gate measured 8/10 and 9/10 against a frozen 100%, so
    // the flip is not earned and the baseline pair stays the default.
    expect(DEFAULT_ORIENT_VERSION).toBe("v6");
    expect(DEFAULT_CRITIC_VERSION).toBe("v4");
    expect(activeOrientPrompt().pass).toBe("orient.v6");
    expect(activeCriticPrompt().pass).toBe("critic.v4");
  });

  it("v7 / v5 stay selectable, so the re-measure is one env var away", () => {
    expect(Object.keys(ORIENT_VERSIONS)).toContain("v7");
    expect(Object.keys(CRITIC_VERSIONS)).toContain("v5");
    expect(PROMPT_VERSION_ENV.orient).toBe("SUPERTWIN_PROMPT_ORIENT");
    expect(PROMPT_VERSION_ENV.critic).toBe("SUPERTWIN_PROMPT_CRITIC");
  });

  it("the merged pass still embeds orient.v7's own text, so a green re-measure would carry", () => {
    // If live.v1 paraphrased orient.v7 instead of embedding it, a TOP score
    // measured on the orient pass would say nothing about the merged live
    // lane we would be flipping back to. It does not paraphrase — and while
    // the gate is red the lane does not run it at all (see the fallback
    // block below).
    const live = LIVE_VERSIONS[DEFAULT_LIVE_VERSION];
    expect(live.pass).toBe("live.v1");
    expect(LIVE_V1.system).toContain(ORIENT_V7_SCHEMA);
    expect(LIVE_V1.system).toContain(ORIENT_V7_PACK);
  });
});

describe("§7.3 fallback — one of the four is red, so the retirement is blocked", () => {
  it("the fallback is ENGAGED: the merged pack stays and the live lane makes TWO calls", () => {
    // "Keep the merged pack, make two calls, do not delete assist/." Not a
    // switch someone could forget to throw — the default itself.
    expect(DEFAULT_LIVE_MODE).toBe("two-call");
    expect(activeLiveMode()).toBe("two-call");
    // The merged pack is the S3.2 packer, and both calls read the same one:
    // the decide prompt describes the very same blocks.
    expect(LIVE_DECIDE_V1.system).toContain(ORIENT_V7_PACK);
    // Call 1 is the FROZEN orient prompt, byte for byte — the pass the golden
    // set scores. That is what makes the fallback worth anything.
    expect(activeOrientPrompt().pass).toBe("orient.v6");
    // Call 2 is P-01's decide half, sharing its schema verbatim with live.v1
    // so both modes parse one shape.
    expect(LIVE_DECIDE_V1.pass).toBe("live-decide.v1");
    expect(LIVE_V1.system).toContain(LIVE_V1_DECIDE_SCHEMA);
    expect(LIVE_DECIDE_V1.system).toContain(LIVE_V1_DECIDE_SCHEMA);
  });

  it("the merged one-call pass stays selectable, so flipping back is one env var", () => {
    expect(LIVE_PROMPT_ENV).toBe("SUPERTWIN_PROMPT_LIVE");
    expect(LIVE_PROMPT_OFF).toBe("off");
    expect(LIVE_PROMPT_TWO_CALL).toBe("two-call");
    const saved = process.env[LIVE_PROMPT_ENV];
    try {
      process.env[LIVE_PROMPT_ENV] = "v1";
      expect(activeLiveMode()).toBe("merged");
      expect(activeLivePrompt()!.pass).toBe("live.v1");
      process.env[LIVE_PROMPT_ENV] = LIVE_PROMPT_OFF;
      expect(activeLiveMode()).toBe("off");
      expect(activeLivePrompt()).toBeNull();
      process.env[LIVE_PROMPT_ENV] = "nonsense";
      expect(activeLiveMode()).toBe(DEFAULT_LIVE_MODE); // a typo never takes the lane down
    } finally {
      if (saved === undefined) delete process.env[LIVE_PROMPT_ENV];
      else process.env[LIVE_PROMPT_ENV] = saved;
    }
  });

  it("`assist/` is STILL IN THE TREE — §7.3 gates its deletion on all four", () => {
    // Delete this test in the same commit that deletes assist/, and only once
    // `npm run eval -- --cat TOP --compare-baseline` reports COMPARE: green.
    // S4.4 could not do it: item 1 is red, so the input-side gate, its watcher
    // and its evaluator stay where they are.
    for (const f of ["index.ts", "watcher.ts", "evaluator.ts", "gate.ts", "artifacts.ts"]) {
      expect(existsSync(join(import.meta.dirname, "../assist", f)), `assist/${f}`).toBe(true);
    }
  });

  it("the behavioural thresholds already moved — one floor, one reader, both sides", () => {
    // S4.4's half of the retirement that does NOT need assist/ gone: the
    // output-side verdict. brain/live.ts (the writer) and surfaces/router.ts
    // (the reader) used to hold two different defaults for the same
    // `assist.intent_confidence_min` row — 0.7 and 0.6 — so an action at 0.65
    // was shelved by one and carded by the other. Now there is one function.
    expect(DEFAULT_INTENT_FLOOR).toBe(DEFAULT_NUDGE_INTENT_FLOOR);
    expect(nudgeThresholds().intentFloor).toBe(DEFAULT_NUDGE_INTENT_FLOOR);
    const t = { intentFloor: 0.7, blockedKinds: ["something_moved"] };
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.65 }, t).surface).toBe("shelf");
    expect(nudgeVerdict({ kind: "needs_you", intentConfidence: 0.7 }, t).surface).toBe("card");
    expect(nudgeVerdict({ kind: "something_moved", intentConfidence: 0.99 }, t).verdict).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Item 2 — AST parity
// ---------------------------------------------------------------------------

describe("§7.3 item 2 — AST parity on the re-homed cases", () => {
  it("every assertion the retiring assist/ lane proved has a home that exists", () => {
    expect(astParityGaps(corpusIds())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Item 3 — CROSS-N50 is authored and wired
// ---------------------------------------------------------------------------

describe("§7.3 item 3 — CROSS-N50", () => {
  it("is a deterministic fixture on the cross pass (graded in executors/cross.test.ts)", () => {
    const fixture = loadFixture(join(FIX, "CROSS-N50.json"));
    expect(fixture).toMatchObject({ id: "CROSS-N50", category: "CROSS", pass: "cross", mode: "code" });
    const setup = fixture.setup as { events: unknown[]; streams: { source: string }[]; lane: string };
    expect(setup.events).toHaveLength(50);
    expect(setup.streams).toHaveLength(6);
    expect(new Set(setup.streams.map((s) => s.source)).size).toBe(3);
    expect(setup.lane).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Item 4 — a stale "pay by 5 pm" in a history bundle prepares nothing
// ---------------------------------------------------------------------------

/** [NOW] Sat 2026-09-05 16:10 IST; the bundle is a day from JUNE. */
const NOW = "2026-09-05T10:40:00.000Z";
/** 2026-06-12 → 85 days before [NOW]. The 5 pm it names is twelve weeks gone. */
const JUNE_MINUTES_AGO = 85 * 24 * 60;

/**
 * The recorded live.v1 answer for the stale day: the episode files, and the
 * decide half offers a prepared action anyway — the "pay by 5 pm" read as if
 * it were today. Code, not the model, is what must refuse it.
 */
function staleDay(lane: "history" | "live"): Record<string, unknown> {
  return {
    now: NOW,
    lane,
    spaces: [
      { id: "sp_goa_dec", label: "Goa trip with Rohan in December", goal: "4 people, 18-21 Dec", status: "active" },
    ],
    tasks: [
      {
        id: "t_88",
        space: "sp_goa_dec",
        title: "pay villa advance ₹15,000",
        owner: "self",
        due: "2026-06-12",
        risk_class: "approve-first",
        type: "explicit",
      },
    ],
    // Thread history and an open episode from the same June day: without them
    // the pack is THIN and code strips everything (LIV-10), which would make
    // the control below prove nothing about the LANE.
    history: [
      {
        alias: "h1",
        stream: "S1",
        actor: "contact:rohan",
        text: "villa sol wale bol rahe advance chahiye",
        minutes_ago: JUNE_MINUTES_AGO + 22,
        episode: "ep_june",
      },
      {
        alias: "h2",
        stream: "S1",
        actor: "contact:karan",
        text: "kitna?",
        minutes_ago: JUNE_MINUTES_AGO + 18,
        episode: "ep_june",
      },
      {
        alias: "h3",
        stream: "S1",
        actor: "contact:rohan",
        text: "15k total, 5k each",
        minutes_ago: JUNE_MINUTES_AGO + 14,
        episode: "ep_june",
      },
    ],
    episodes: [{ id: "ep_june", space: "sp_goa_dec", summary: "advance discussion, June" }],
    events: [
      {
        alias: "e1",
        stream: "S1",
        actor: "contact:rohan",
        text: "advance by 5 pm today or they release it",
        minutes_ago: JUNE_MINUTES_AGO,
      },
      {
        alias: "e2",
        stream: "S1",
        actor: "self",
        text: "haan bhej deta hoon",
        minutes_ago: JUNE_MINUTES_AGO - 4,
      },
    ],
    live: {
      episodes: [
        {
          action: "join",
          episode: "ep_june",
          stream: "S1",
          events: ["e1", "e2"],
          summary: "Villa Sol advance had to be paid by 5 pm that day.",
          space: "sp_goa_dec",
          evidence: [{ event_ids: ["e1"], quote: "advance by 5 pm today or they release it" }],
          confidence: 0.95,
        },
      ],
      proposals: [],
      unsorted: [],
      questions: [],
      decide: {
        tasks: [],
        closures: [],
        schedules: [],
        prepared: [
          {
            kind: "needs_you",
            intent: "Pay the Villa Sol advance before 5 pm",
            intent_confidence: 0.94,
            action: "question",
            space: "sp_goa_dec",
            urgency: "today",
            deadline_at: "2026-06-12T17:00:00+05:30",
            inputs: { task: "t_88", amount: "₹15,000" },
            grounded_in: ["e1"],
            reasoning: "Open task t_88 has a hard deadline from Rohan's message.",
          },
        ],
      },
    },
  };
}

let tmpDir: string;

describe("§7.3 item 4 — a stale \"pay by 5 pm\" in a history bundle", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-shipgate-"));
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
    setConsentGateMode("open");
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function drive(lane: "history" | "live"): Promise<LivRun> {
    const run = await runLivCase(`SHIPGATE-${lane.toUpperCase()}`, staleDay(lane));
    return run;
  }

  it("emits ZERO prepared actions, and the decide half never runs at all", async () => {
    const run = await drive("history");
    try {
      expect(run.prepared).toHaveLength(0);
      // Not "prepared then filtered": on a history bundle live.v1 is not the
      // prompt that runs, so there is no decide half to filter.
      expect(run.report.live).toBeUndefined();
      expect(
        (getDb()
          .prepare(`SELECT COUNT(*) AS n FROM deferred_outputs WHERE kind = 'prepared_action'`)
          .get() as { n: number }).n,
      ).toBe(0);
    } finally {
      cleanupLiv(run.seeded, run.report.commit?.committedEpisodes.map((e) => e.episodeId) ?? []);
    }
  });

  it("still files the day — zero nudges is not zero understanding", async () => {
    const run = await drive("history");
    try {
      expect(run.report.status).toBe("committed");
      const ep = run.episodes.find((e) => e.members.includes("e1"));
      expect(ep).toBeDefined();
      expect(ep!.space_id).toBe("sp_goa_dec");
      // The stale deadline did not silently close the open task either.
      expect(run.tasks.find((t) => t.id === "t_88")!.status).toBe("open");
    } finally {
      cleanupLiv(run.seeded, run.report.commit?.committedEpisodes.map((e) => e.episodeId) ?? []);
    }
  });

  it("CONTROL: the identical bundle on the live lane does prepare — the zero is the lane rule, not dead code", async () => {
    const run = await drive("live");
    try {
      expect(run.report.live).toBeDefined();
      expect(run.prepared).toHaveLength(1);
      expect(run.prepared[0]!.payload.kind).toBe("needs_you");
    } finally {
      cleanupLiv(run.seeded, run.report.commit?.committedEpisodes.map((e) => e.episodeId) ?? []);
    }
  });

  it("nothing was left behind for the next bundle to pick up", async () => {
    const run = await drive("history");
    cleanupLiv(run.seeded, run.report.commit?.committedEpisodes.map((e) => e.episodeId) ?? []);
    expect(listPreparedActions({ limit: 50 })).toEqual([]);
  });
});
