// ===========================================================================
// The arc binding ladder (§11.2, item 2.5) — evals category L.
//
// Every rung is exercised at its own boundary, and the four rules that make the
// ladder more than an ordered list are asserted directly:
//   * bridges run first (L-001..L-008)
//   * the overlap bar is >= 0.5 and topics alone never carry it (L-009..L-017)
//   * similarity NOMINATES, adjudication decides (L-018..L-023)
//   * ambient joins via ① or ② only (L-024..L-027)
//   * no adjudicator = defer, zero model calls, first paint proceeds
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { putCalib } from "../db/calib.js";
import { closeDb, runMigrations } from "../db/connection.js";
import { MIN_CALIB_PAIRS } from "../retrieval/calibration-floor.js";
import { buildAg2Prompt, type Ag2Candidate } from "../prompts/p-ag2.js";
import { USE_CASE_BARS } from "../retrieval/calibration.js";
import {
  ARC_JOIN_CONFIDENCE_FLOOR,
  ARC_USE_CASE,
  bridgeRung,
  overlapRung,
  runArcLadder,
  similarityRung,
  type ArcAdjudicator,
  type BridgeReader,
  type LadderCandidate,
  type LadderEpisode,
} from "./ladder.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;
const EMBEDDER = "eval-embedder";
/** floor 0 makes the normalised score equal the cosine, so a case can state it. */
const SCORE_OPTS = { model: EMBEDDER, now: NOW } as const;

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-arcladder-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  putCalib({
    model: EMBEDDER,
    useCase: ARC_USE_CASE,
    floor: 0,
    nPairs: MIN_CALIB_PAIRS,
    measuredAt: new Date(NOW - DAY).toISOString(),
  });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const person = (id: string) => ({ entityId: id, type: "person" });
const topic = (id: string) => ({ entityId: id, type: "topic" });

const episode = (over: Partial<LadderEpisode> = {}): LadderEpisode => ({
  id: "ep_new",
  label: "villa shortlist",
  sourceId: "browser",
  anchors: [person("a1")],
  bridgeIds: ["ep_new"],
  ...over,
});

const candidate = (id: string, over: Partial<LadderCandidate> = {}): LadderCandidate => ({
  arcId: id,
  label: `arc ${id}`,
  sourceIds: ["whatsapp"],
  anchors: [person("a9")],
  bridgeIds: [`${id}_ep`],
  cosine: null,
  ...over,
});

/** No bridges anywhere, unless a test says otherwise. */
const noBridges: BridgeReader = () => [];

const bridgeTo = (farId: string, kind = "url", confidence = 1): BridgeReader => (ids) =>
  ids.flatMap((id) => [
    { kind, value_norm: "site0.com/x", left_id: id, right_id: farId, confidence },
  ]);

/** An adjudicator that answers with one frozen line against the real prompt. */
const answering = (line: (aliases: Record<string, string>, ep: string) => string, calls = 1): ArcAdjudicator => (
  req,
) => {
  const prompt = buildAg2Prompt({
    episode: { id: req.episode.id, label: req.episode.label },
    candidates: req.candidates as Ag2Candidate[],
  });
  return { response: line(prompt.aliases, prompt.episodeAlias), table: prompt.table, calls };
};

describe("rung ① — bridges run first (L-001..L-008)", () => {
  it("joins the arc holding the far end of the bridge", () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const arcId = `arc_n${n}`;
      const result = runArcLadder(episode(), [candidate(arcId)], {
        ...SCORE_OPTS,
        bridges: bridgeTo(`${arcId}_ep`),
      });
      expect(result.decision).toBe("join");
      expect(result.rung).toBe("bridge");
      expect(result.arcId).toBe(arcId);
      expect(result.modelCalls).toBe(0);
    }
  });

  it("beats a higher-overlap candidate — precision order, not score order", () => {
    const bridged = candidate("arc_bridged", { anchors: [person("z1")] });
    const overlapping = candidate("arc_overlap", { anchors: [person("a1")], bridgeIds: ["other_ep"] });
    const result = runArcLadder(episode(), [overlapping, bridged], {
      ...SCORE_OPTS,
      bridges: bridgeTo("arc_bridged_ep"),
    });
    expect(result.rung).toBe("bridge");
    expect(result.arcId).toBe("arc_bridged");
  });

  it("prefers the strongest bridge and breaks ties on arc id", () => {
    const reader: BridgeReader = () => [
      { kind: "geo_time", value_norm: "g|t", left_id: "ep_new", right_id: "arc_b_ep", confidence: 0.8 },
      { kind: "url", value_norm: "u", left_id: "ep_new", right_id: "arc_a_ep", confidence: 1 },
    ];
    const result = runArcLadder(episode(), [candidate("arc_a"), candidate("arc_b")], {
      ...SCORE_OPTS,
      bridges: reader,
    });
    expect(result.arcId).toBe("arc_a");
    expect(result.bridge?.kind).toBe("url");
  });

  it("ignores a bridge whose far end belongs to no candidate", () => {
    expect(bridgeRung(episode(), [candidate("arc_a")], bridgeTo("stranger_ep"))).toBeNull();
  });

  it("reads the mirrored row from either side", () => {
    const reader: BridgeReader = () => [
      { kind: "url", value_norm: "u", left_id: "arc_a_ep", right_id: "ep_new", confidence: 1 },
    ];
    expect(bridgeRung(episode(), [candidate("arc_a")], reader)?.arcId).toBe("arc_a");
  });
});

describe("rung ② — weighted entity overlap (L-009..L-017)", () => {
  it("L-011: exactly 0.50 joins", () => {
    const ep = episode({ anchors: [person("s0"), person("s1"), person("a0")] });
    const arc = candidate("arc_x", { anchors: [person("s0"), person("s1"), person("b0")] });
    const result = runArcLadder(ep, [arc], { ...SCORE_OPTS, bridges: noBridges });
    expect(result.decision).toBe("join");
    expect(result.rung).toBe("overlap");
    expect(result.confidence).toBe(0.5);
    expect(result.modelCalls).toBe(0);
  });

  it("L-009/L-010: under the bar does not join, and the ladder falls through", () => {
    const ep = episode({ anchors: [person("s0"), person("a0"), person("a1")] });
    const arc = candidate("arc_x", { anchors: [person("s0"), person("b0"), person("b1")] });
    const result = runArcLadder(ep, [arc], { ...SCORE_OPTS, bridges: noBridges });
    expect(result.decision).not.toBe("join");
    expect(result.overlaps[0]?.score).toBeLessThan(0.5);
  });

  it("L-017: a shared topic alone is not enough, whatever the ratio", () => {
    const ep = episode({ anchors: [topic("t1"), topic("t2")] });
    const arc = candidate("arc_x", { anchors: [topic("t1"), topic("t2")] });
    const result = runArcLadder(ep, [arc], { ...SCORE_OPTS, bridges: noBridges });
    expect(result.overlaps[0]?.score).toBe(1);
    expect(result.overlaps[0]?.joins).toBe(false);
    expect(result.decision).not.toBe("join");
  });

  it("scores every candidate, best first, so the verdict row shows the field", () => {
    const ep = episode({ anchors: [person("s0"), person("s1")] });
    const scores = overlapRung(ep, [
      candidate("arc_far", { anchors: [person("z")] }),
      candidate("arc_near", { anchors: [person("s0"), person("s1")] }),
    ]);
    expect(scores.map((s) => s.arcId)).toEqual(["arc_near", "arc_far"]);
  });
});

describe("rung ③ — similarity NOMINATES, it never joins (L-018..L-023)", () => {
  const nominatingLadder = (cosine: number, adjudicator: ArcAdjudicator | null) =>
    runArcLadder(
      episode({ anchors: [person("s0"), person("a1"), person("a2")] }),
      [
        candidate("arc_goa", {
          anchors: [person("s0"), person("b1"), person("b2")],
          cosine,
          sourceIds: ["whatsapp"],
        }),
      ],
      { ...SCORE_OPTS, bridges: noBridges, adjudicator },
    );

  it("sends 0.68 through 0.88 to P-AG2 — exactly one call, every time", () => {
    for (const sim of [0.68, 0.72, 0.76, 0.8, 0.84, 0.88]) {
      const result = nominatingLadder(
        sim,
        answering((aliases, ep) => `V|${ep}|jn|${aliases.arc_goa}|0.9|same villa`),
      );
      expect(result.rung).toBe("adjudication");
      expect(result.modelCalls).toBe(1);
      expect(result.nominated).toEqual(["arc_goa"]);
      expect(result.decision).toBe("join");
    }
  });

  it("never joins on the score alone, even above the bind bar", () => {
    const above = USE_CASE_BARS.arc_topic.bind + 0.2;
    const result = nominatingLadder(above, null);
    expect(result.decision).toBe("defer");
    expect(result.rung).toBe("adjudication");
    expect(result.modelCalls).toBe(0);
  });

  it("uses arc_topic bars, which sit strictly above episode_topic", () => {
    expect(USE_CASE_BARS.arc_topic.bind).toBeGreaterThan(USE_CASE_BARS.episode_topic.bind);
    expect(USE_CASE_BARS.arc_topic.band).toBeGreaterThan(USE_CASE_BARS.episode_topic.band);
  });

  it("nominates nobody below the band, and spends no call", () => {
    const result = nominatingLadder(USE_CASE_BARS.arc_topic.band - 0.1, answering(() => "V|e1|jn|n1|1|no"));
    expect(result.nominated).toEqual([]);
    expect(result.modelCalls).toBe(0);
    expect(result.decision).toBe("new");
  });

  it("does not score a candidate whose cosine was never measured", () => {
    expect(similarityRung([candidate("arc_x", { cosine: null })], SCORE_OPTS)).toEqual([]);
  });

  it("nominates nobody on an uncalibrated model — a guessed score is not evidence", () => {
    const result = runArcLadder(
      episode(),
      [candidate("arc_x", { cosine: 0.99 })],
      { model: "never-calibrated", now: NOW, bridges: noBridges, adjudicator: answering(() => "V|e1|jn|n1|1|x") },
    );
    expect(result.nominated).toEqual([]);
    expect(result.modelCalls).toBe(0);
    expect(result.decision).toBe("new");
    expect(result.reason).toContain("no candidate could be scored");
  });
});

describe("rung ④ — adjudication (L-018..L-023)", () => {
  const posed = (adjudicator: ArcAdjudicator | null) =>
    runArcLadder(
      episode({ anchors: [person("s0"), person("a1"), person("a2")] }),
      [candidate("arc_goa", { anchors: [person("s0"), person("b1"), person("b2")], cosine: 0.8 })],
      { ...SCORE_OPTS, bridges: noBridges, adjudicator },
    );

  it("jn joins", () => {
    const result = posed(answering((a, ep) => `V|${ep}|jn|${a.arc_goa}|0.97|exact url bridge`));
    expect(result.decision).toBe("join");
    expect(result.arcId).toBe("arc_goa");
    expect(result.verdict?.verdict).toBe("join");
  });

  it("nw starts a new arc", () => {
    const result = posed(answering((_, ep) => `V|${ep}|nw|-|0.9|different matter`));
    expect(result.decision).toBe("new");
    expect(result.arcId).toBeNull();
    expect(result.verdict?.verdict).toBe("new");
  });

  it("un asks the user and binds nothing", () => {
    const result = posed(answering((a, ep) => `V|${ep}|un|${a.arc_goa}|0.4|cannot tell`));
    expect(result.decision).toBe("ask_user");
    expect(result.arcId).toBeNull();
    expect(result.question).toContain("villa shortlist");
  });

  it("demotes a jn below the join floor and keeps what the model said", () => {
    const low = ARC_JOIN_CONFIDENCE_FLOOR - 0.1;
    const result = posed(answering((a, ep) => `V|${ep}|jn|${a.arc_goa}|${low}|not really sure`));
    expect(result.decision).toBe("new");
    expect(result.demotedReason).toContain(`< ${ARC_JOIN_CONFIDENCE_FLOOR}`);
    expect(result.verdict?.verdict).toBe("join");
    expect(result.verdict?.reason).toBe("not really sure");
  });

  it("demotes a jn naming an arc it was not offered", () => {
    const result = posed(answering((_, ep) => `V|${ep}|jn|n7|0.99|certain`));
    expect(result.decision).toBe("new");
    expect(result.demotedReason).toContain("not an arc offered");
  });

  it("defers when the answer holds no usable V line", () => {
    const result = posed(answering(() => "I think they go together."));
    expect(result.decision).toBe("defer");
    expect(result.modelCalls).toBe(1);
  });
});

describe("ambient joins via ① or ② ONLY (L-024..L-027)", () => {
  const ambient = (over: Partial<LadderCandidate>) =>
    runArcLadder(
      episode({ id: "ep_screen", ambient: true, sourceId: "screen", anchors: [person("s0")] }),
      [candidate("arc_x", { anchors: [person("z9")], ...over })],
      {
        ...SCORE_OPTS,
        bridges: noBridges,
        adjudicator: answering((a, ep) => `V|${ep}|jn|${a.arc_x}|0.99|looks the same`),
      },
    );

  it("refuses a 0.9 similarity with no bridge and no overlap", () => {
    for (const _ of [1, 2, 3, 4]) {
      const result = ambient({ cosine: 0.9 });
      expect(result.decision).toBe("new");
      expect(result.arcId).toBeNull();
      expect(result.modelCalls).toBe(0);
      expect(result.similarities).toEqual([]);
      expect(result.reason).toContain("rungs ③ and ④ are closed");
    }
  });

  it("still joins an ambient episode on a bridge", () => {
    const result = runArcLadder(
      episode({ id: "ep_screen", ambient: true, bridgeIds: ["ep_screen"] }),
      [candidate("arc_x")],
      { ...SCORE_OPTS, bridges: bridgeTo("arc_x_ep") },
    );
    expect(result.decision).toBe("join");
    expect(result.rung).toBe("bridge");
  });

  it("still joins an ambient episode on entity overlap", () => {
    const result = runArcLadder(
      episode({ id: "ep_screen", ambient: true, anchors: [person("s0"), person("s1")] }),
      [candidate("arc_x", { anchors: [person("s0"), person("s1")] })],
      { ...SCORE_OPTS, bridges: noBridges },
    );
    expect(result.decision).toBe("join");
    expect(result.rung).toBe("overlap");
  });
});

describe("first paint never waits on a model", () => {
  it("defers rather than calling when no adjudicator is on this path", () => {
    const result = runArcLadder(
      episode({ anchors: [person("s0"), person("a1"), person("a2")] }),
      [candidate("arc_goa", { anchors: [person("s0"), person("b1"), person("b2")], cosine: 0.8 })],
      { ...SCORE_OPTS, bridges: noBridges, adjudicator: null },
    );
    expect(result.decision).toBe("defer");
    expect(result.modelCalls).toBe(0);
    expect(result.reason).toContain("provisional arc");
  });

  it("an episode with no candidate at all is a new arc, with no call and no bridge read", () => {
    let reads = 0;
    const counting: BridgeReader = (ids) => {
      reads += ids.length;
      return [];
    };
    const result = runArcLadder(episode(), [], { ...SCORE_OPTS, bridges: counting });
    expect(result.decision).toBe("new");
    expect(result.rung).toBeNull();
    expect(reads).toBe(0);
  });
});
