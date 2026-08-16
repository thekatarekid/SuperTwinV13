// ===========================================================================
// Episode topic vectors and the attach gate (build item 2.3).
//
// The acceptance box is a NEGATIVE: "no similarity call runs on an
// uncalibrated model". So most of what is asserted here is what does NOT
// happen — no embed call, no cosine, no score — when the `episode_topic` floor
// is missing or stale, and that the pair leaves for the agent or the question
// queue instead.
//
// The other half is the cold-start rule that makes calibration possible at all:
// WRITING an episode vector is never gated, because `episode_embeddings` is the
// corpus the floor is measured from.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MIN_CALIB_PAIRS } from "../retrieval/calibration.js";
import { activeEmbeddingModel } from "../retrieval/model-registry.js";
import { putCalib, resetCalibCacheForTests } from "../db/calib.js";
import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { upsertSource, upsertStream } from "../db/ingest.js";
import {
  EPISODE_SUMMARY_COUNT,
  MAX_TOPIC_TEXT_CHARS,
  buildEpisodeTopicText,
  collectEpisodeTopicParts,
  embedEpisodeTopic,
  episodeAttachGate,
  episodeTopicTextIsUsable,
  putEpisodeEmbedding,
  readEpisodeEmbedding,
  summariseSession,
  topEntityNames,
} from "./embed.js";
import { writeEpisode } from "./store.js";

const MODEL = activeEmbeddingModel().id;
const DIM = 4;
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

let tmpDir: string;
let STREAM = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-epembed-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  resetCalibCacheForTests();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  STREAM = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Rohan", kind: "dm" });
});

afterEach(() => {
  closeDb();
  resetCalibCacheForTests();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---- fixtures --------------------------------------------------------------

function seedCalib(floor: number, ageMs = 0): void {
  putCalib({
    model: MODEL,
    useCase: "episode_topic",
    floor,
    nPairs: MIN_CALIB_PAIRS + 10,
    measuredAt: new Date(NOW - ageMs).toISOString(),
  });
}

function event(id: string, text: string, agoDays = 0): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, source_id, source_type, stream_id, ts, kind, text)
       VALUES (?, 'whatsapp', 'whatsapp', ?, ?, 'message', ?)`,
    )
    .run(id, STREAM, new Date(NOW - agoDays * DAY).toISOString(), text);
}

function session(id: string, eventIds: string[], agoDays = 0): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, 'sealed')`,
    )
    .run(
      id,
      STREAM,
      new Date(NOW - agoDays * DAY).toISOString(),
      new Date(NOW - agoDays * DAY + 3_600_000).toISOString(),
      JSON.stringify(eventIds),
    );
}

function entity(id: string, canonical: string, mergedInto: string | null = null): void {
  getDb()
    .prepare(`INSERT INTO entities (id, type, canonical, merged_into) VALUES (?, 'person', ?, ?)`)
    .run(id, canonical, mergedInto);
}

function mention(id: string, eventId: string, entityId: string): void {
  getDb()
    .prepare(`INSERT INTO mentions (id, event_id, entity_id) VALUES (?, ?, ?)`)
    .run(id, eventId, entityId);
}

function episode(
  id: string,
  opts: { label?: string | null; sessionIds?: string[]; eventIds?: string[]; entityIds?: string[] } = {},
): void {
  const sessionIds = opts.sessionIds ?? [];
  for (const [i, sessionId] of sessionIds.entries()) {
    writeEpisode(
      {
        id,
        streamId: STREAM,
        topicLabel: opts.label === undefined ? "the kitchen renovation" : opts.label,
        labelSource: "model",
        sessionId,
        eventIds: i === 0 ? (opts.eventIds ?? []) : [],
        entityIds: i === 0 ? (opts.entityIds ?? []) : [],
        startedAt: new Date(NOW - DAY).toISOString(),
        endedAt: new Date(NOW).toISOString(),
        addedBy: "new",
      },
      { now: NOW },
    );
  }
  if (sessionIds.length === 0) {
    getDb()
      .prepare(
        `INSERT INTO episodes (id, stream_id, topic_label, session_ids, event_ids, entity_ids, arc_state)
         VALUES (?, ?, ?, '[]', ?, ?, 'open')`,
      )
      .run(
        id,
        STREAM,
        opts.label === undefined ? "the kitchen renovation" : opts.label,
        JSON.stringify(opts.eventIds ?? []),
        JSON.stringify(opts.entityIds ?? []),
      );
  }
}

/** A unit vector at a chosen cosine from `probe`. */
function atCosine(c: number): Float32Array {
  return Float32Array.from([c, Math.sqrt(Math.max(0, 1 - c * c)), 0, 0]);
}
const PROBE = Float32Array.from([1, 0, 0, 0]);

const RICH =
  "name: the kitchen renovation · with: Rohan, Meera · context: the carpenter quoted 84k for the counters";

function stubEmbed(vector: Float32Array = PROBE) {
  return vi.fn(async (texts: readonly string[]) => texts.map(() => vector));
}

// ---- composition -----------------------------------------------------------

describe("buildEpisodeTopicText", () => {
  it("composes label, the last two summaries and the top entity names", () => {
    const text = buildEpisodeTopicText({
      topicLabel: "the kitchen renovation",
      summaries: ["carpenter quoted 84k for the counters", "we chose the walnut finish"],
      entityNames: ["Rohan", "Meera"],
    });
    expect(text).toContain("the kitchen renovation");
    expect(text).toContain("Rohan, Meera");
    expect(text).toContain("carpenter quoted 84k");
    expect(text).toContain("walnut finish");
    expect(episodeTopicTextIsUsable(text)).toBe(true);
  });

  it("is byte-stable for the same parts, so a replay embeds the same text", () => {
    const parts = {
      topicLabel: "sunday plans",
      summaries: ["booked oye kake for eight"],
      entityNames: ["Meera"],
    };
    expect(buildEpisodeTopicText(parts)).toBe(buildEpisodeTopicText(parts));
  });

  it("keeps only two summaries and caps the composed length", () => {
    const text = buildEpisodeTopicText({
      topicLabel: "x".repeat(400),
      summaries: ["a".repeat(500), "b".repeat(500), "c".repeat(500)],
      entityNames: Array.from({ length: 30 }, (_, i) => `person ${i}`),
    });
    expect(text.length).toBeLessThanOrEqual(MAX_TOPIC_TEXT_CHARS);
    expect(text).not.toContain("ccc");
    expect(EPISODE_SUMMARY_COUNT).toBe(2);
  });

  it("drops enrichment placeholders, which carry no topic signal", () => {
    const text = buildEpisodeTopicText({
      topicLabel: "beach day",
      summaries: ["[image, description pending]", "we drove down at six and swam till noon"],
      entityNames: [],
    });
    expect(text).not.toContain("pending");
    expect(text).toContain("drove down at six");
  });

  it("refuses to call a bare label rich text", () => {
    const text = buildEpisodeTopicText({ topicLabel: "plans", summaries: [], entityNames: [] });
    expect(episodeTopicTextIsUsable(text)).toBe(false);
  });
});

// ---- gathering -------------------------------------------------------------

describe("collectEpisodeTopicParts", () => {
  it("takes the two NEWEST sessions and the most-mentioned entities", () => {
    event("e1", "the carpenter quoted 84k for the counters", 3);
    event("e2", "we chose the walnut finish in the end", 2);
    event("e3", "delivery slipped to the fifteenth", 1);
    session("s_old", ["e1"], 3);
    session("s_mid", ["e2"], 2);
    session("s_new", ["e3"], 1);
    entity("en_rohan", "Rohan");
    entity("en_meera", "Meera");
    mention("m1", "e1", "en_meera");
    mention("m2", "e2", "en_rohan");
    mention("m3", "e3", "en_rohan");
    episode("ep1", {
      sessionIds: ["s_old", "s_mid", "s_new"],
      eventIds: ["e1", "e2", "e3"],
      entityIds: ["en_meera", "en_rohan"],
    });

    const parts = collectEpisodeTopicParts("ep1");
    expect(parts).not.toBeNull();
    expect(parts!.summaries).toHaveLength(2);
    expect(parts!.summaries[0]).toContain("delivery slipped");
    expect(parts!.summaries[1]).toContain("walnut finish");
    expect(parts!.summaries.join(" ")).not.toContain("84k");
    // Rohan is mentioned twice, Meera once — count wins over array order.
    expect(parts!.entityNames).toEqual(["Rohan", "Meera"]);
  });

  it("accepts an injected summariser and follows merged entities", () => {
    event("e1", "anything", 1);
    session("s1", ["e1"], 1);
    entity("en_survivor", "Rohan Mehta");
    entity("en_dupe", "Rohan", "en_survivor");
    mention("m1", "e1", "en_dupe");
    episode("ep1", { sessionIds: ["s1"], eventIds: ["e1"], entityIds: ["en_dupe"] });

    const parts = collectEpisodeTopicParts("ep1", { summarize: () => "a hand written summary" });
    expect(parts!.summaries).toEqual(["a hand written summary"]);
    expect(parts!.entityNames).toEqual(["Rohan Mehta"]);
  });

  it("returns null for an episode that does not exist", () => {
    expect(collectEpisodeTopicParts("nope")).toBeNull();
  });

  it("summarises a session from its own events, in session order", () => {
    event("e1", "first line", 1);
    event("e2", "second line", 1);
    session("s1", ["e2", "e1"], 1);
    expect(summariseSession("s1")).toBe("second line · first line");
    expect(summariseSession("missing")).toBeNull();
  });

  it("ranks entities without any mention rows by the episode's own order", () => {
    entity("en_a", "Ayesha");
    entity("en_b", "Bilal");
    expect(topEntityNames(["en_b", "en_a"], [])).toEqual(["Bilal", "Ayesha"]);
  });
});

// ---- writing vectors -------------------------------------------------------

describe("embedEpisodeTopic", () => {
  function fullEpisode(): void {
    event("e1", "the carpenter quoted 84k for the counters", 2);
    event("e2", "we chose the walnut finish in the end", 1);
    session("s1", ["e1"], 2);
    session("s2", ["e2"], 1);
    entity("en_rohan", "Rohan");
    mention("m1", "e1", "en_rohan");
    episode("ep1", {
      sessionIds: ["s1", "s2"],
      eventIds: ["e1", "e2"],
      entityIds: ["en_rohan"],
    });
  }

  it("stores a vector with NO calibration at all — this table is the calibration corpus", async () => {
    fullEpisode();
    const embed = stubEmbed();
    const result = await embedEpisodeTopic("ep1", { embed, model: MODEL, dim: DIM });

    expect(result.stored).toBe(true);
    expect(result.skipped).toBeNull();
    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.text).toContain("the kitchen renovation");
    expect(readEpisodeEmbedding("ep1", { model: MODEL, dim: DIM })).toEqual(PROBE);
  });

  it("upserts — re-embedding leaves one row, not a twin", async () => {
    fullEpisode();
    await embedEpisodeTopic("ep1", { embed: stubEmbed(), model: MODEL, dim: DIM });
    await embedEpisodeTopic("ep1", { embed: stubEmbed(atCosine(0.2)), model: MODEL, dim: DIM });
    const n = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM episode_embeddings WHERE episode_id = 'ep1'`)
      .get() as { n: number };
    expect(n.n).toBe(1);
    expect(readEpisodeEmbedding("ep1", { model: MODEL, dim: DIM })).toEqual(atCosine(0.2));
  });

  it("does not embed a thin composition, and says why", async () => {
    episode("ep_thin", { label: "plans" });
    const embed = stubEmbed();
    const result = await embedEpisodeTopic("ep_thin", { embed, model: MODEL, dim: DIM });

    expect(result.stored).toBe(false);
    expect(result.skipped).toBe("thin_text");
    expect(embed).not.toHaveBeenCalled();
    expect(readEpisodeEmbedding("ep_thin", { model: MODEL, dim: DIM })).toBeNull();
  });

  it("reports an unknown episode instead of writing anything", async () => {
    const result = await embedEpisodeTopic("nope", { embed: stubEmbed(), model: MODEL, dim: DIM });
    expect(result.stored).toBe(false);
    expect(result.skipped).toBe("unknown_episode");
  });

  it("survives an embedder that returns nothing", async () => {
    fullEpisode();
    const result = await embedEpisodeTopic("ep1", {
      embed: async () => [],
      model: MODEL,
      dim: DIM,
    });
    expect(result.stored).toBe(false);
    expect(result.skipped).toBe("no_vector");
  });

  it("keeps spaces apart — a vector is invisible to another (model, dim)", async () => {
    fullEpisode();
    await embedEpisodeTopic("ep1", { embed: stubEmbed(), model: MODEL, dim: DIM });
    expect(readEpisodeEmbedding("ep1", { model: MODEL, dim: DIM + 1 })).toBeNull();
    expect(readEpisodeEmbedding("ep1", { model: "another-model", dim: DIM })).toBeNull();
  });

  it("rejects a vector whose length disagrees with its dim", () => {
    episode("ep1");
    expect(() => putEpisodeEmbedding({ episodeId: "ep1", vector: [1, 2], model: MODEL, dim: DIM }))
      .toThrow(/2 dimensions, expected 4/);
  });
});

// ---- the gate --------------------------------------------------------------

describe("episodeAttachGate — uncalibrated", () => {
  beforeEach(() => {
    episode("ep1");
    putEpisodeEmbedding({ episodeId: "ep1", vector: atCosine(0.99), model: MODEL, dim: DIM });
  });

  it("runs NO similarity call when the floor was never measured", async () => {
    const embed = stubEmbed();
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep1" }], {
      embed,
      model: MODEL,
      dim: DIM,
    });

    expect(embed).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(result.decision).toBe("escalate");
    expect(result.route).toBe("agent");
    expect(result.scores).toEqual([]);
    expect(result.episodeId).toBeNull();
    expect(result.calibration.state).toBe("missing");
    expect(result.reason).toMatch(/disabled/);
  });

  it("routes to the question queue when no agent is available", async () => {
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep1" }], {
      embed: stubEmbed(),
      model: MODEL,
      dim: DIM,
      agentAvailable: false,
    });
    expect(result.route).toBe("question_queue");
    expect(result.decision).toBe("escalate");
  });

  it("blocks on a STALE row just as hard as on a missing one", async () => {
    seedCalib(0.5, 40 * DAY);
    const embed = stubEmbed();
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep1" }], {
      embed,
      model: MODEL,
      dim: DIM,
      now: NOW,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
    expect(result.calibration.state).toBe("stale");
    expect(result.scores).toEqual([]);
  });

  it("blocks when the row belongs to a DIFFERENT model — a swap disables the rung", async () => {
    putCalib({
      model: "some-other-embedder",
      useCase: "episode_topic",
      floor: 0.5,
      nPairs: MIN_CALIB_PAIRS + 10,
      measuredAt: new Date(NOW).toISOString(),
    });
    const embed = stubEmbed();
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep1" }], {
      embed,
      model: MODEL,
      dim: DIM,
      now: NOW,
    });
    expect(embed).not.toHaveBeenCalled();
    expect(result.enabled).toBe(false);
  });
});

describe("episodeAttachGate — calibrated", () => {
  beforeEach(() => {
    seedCalib(0.5);
    episode("ep_near");
    episode("ep_band");
    episode("ep_far");
    putEpisodeEmbedding({ episodeId: "ep_near", vector: atCosine(0.9), model: MODEL, dim: DIM });
    putEpisodeEmbedding({ episodeId: "ep_band", vector: atCosine(0.72), model: MODEL, dim: DIM });
    putEpisodeEmbedding({ episodeId: "ep_far", vector: atCosine(0.52), model: MODEL, dim: DIM });
  });

  const opts = { model: MODEL, dim: DIM, now: NOW };

  it("attaches to the best candidate over the bind bar, on the NORMALISED scale", async () => {
    const result = await episodeAttachGate(
      RICH,
      [{ episodeId: "ep_far" }, { episodeId: "ep_near" }, { episodeId: "ep_band" }],
      { ...opts, embed: stubEmbed() },
    );
    expect(result.enabled).toBe(true);
    expect(result.decision).toBe("attach");
    expect(result.route).toBe("ml");
    expect(result.episodeId).toBe("ep_near");
    // (0.9 − 0.5) / (1 − 0.5) = 0.8, well over episode_topic's 0.55 bind bar,
    // and NOT the raw cosine.
    expect(result.scores[0]!.decision.score).toBeCloseTo(0.8, 5);
    expect(result.scores.map((s) => s.episodeId)).toEqual(["ep_near", "ep_band", "ep_far"]);
  });

  it("escalates a band score to the judge instead of attaching or splitting", async () => {
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep_band" }], {
      ...opts,
      embed: stubEmbed(),
    });
    expect(result.decision).toBe("escalate");
    expect(result.route).toBe("agent");
    expect(result.episodeId).toBe("ep_band");
    expect(result.scores[0]!.decision.verdict).toBe("unsure");
  });

  it("sends the band to the question queue when there is no agent", async () => {
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep_band" }], {
      ...opts,
      embed: stubEmbed(),
      agentAvailable: false,
    });
    expect(result.route).toBe("question_queue");
  });

  it("says NEW when every candidate scores below the band", async () => {
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep_far" }], {
      ...opts,
      embed: stubEmbed(),
    });
    expect(result.decision).toBe("new");
    expect(result.route).toBe("ml");
    expect(result.episodeId).toBeNull();
    expect(result.scores[0]!.decision.verdict).toBe("different");
  });

  it("says NEW with no candidates at all, and embeds nothing", async () => {
    const embed = stubEmbed();
    const result = await episodeAttachGate(RICH, [], { ...opts, embed });
    expect(result.decision).toBe("new");
    expect(embed).not.toHaveBeenCalled();
  });

  it("lists a candidate with no vector as unscored — absence is not 'different'", async () => {
    episode("ep_blank");
    const result = await episodeAttachGate(
      RICH,
      [{ episodeId: "ep_blank" }, { episodeId: "ep_far" }],
      { ...opts, embed: stubEmbed() },
    );
    expect(result.unscored.map((u) => u.episodeId)).toEqual(["ep_blank"]);
    expect(result.scores.map((s) => s.episodeId)).toEqual(["ep_far"]);
  });

  it("escalates when NOTHING was comparable rather than guessing new", async () => {
    episode("ep_blank");
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep_blank" }], {
      ...opts,
      embed: stubEmbed(),
    });
    expect(result.decision).toBe("escalate");
    expect(result.route).toBe("agent");
    expect(result.scores).toEqual([]);
  });

  it("will not compare across dimensions", async () => {
    getDb()
      .prepare(`UPDATE episode_embeddings SET dim = ? WHERE episode_id = 'ep_near'`)
      .run(DIM);
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep_near", vector: [1, 0] }], {
      ...opts,
      embed: stubEmbed(),
    });
    expect(result.scores).toEqual([]);
    expect(result.unscored[0]!.reason).toMatch(/not comparable/);
  });

  it("prefers an injected candidate vector over the stored one", async () => {
    const result = await episodeAttachGate(
      RICH,
      [{ episodeId: "ep_far", vector: atCosine(0.95) }],
      { ...opts, embed: stubEmbed() },
    );
    expect(result.decision).toBe("attach");
    expect(result.episodeId).toBe("ep_far");
  });

  it("refuses a bare short session string outright", async () => {
    await expect(
      episodeAttachGate("plans", [{ episodeId: "ep_near" }], { ...opts, embed: stubEmbed() }),
    ).rejects.toThrow(/bare short string/);
  });

  it("escalates rather than scoring when the embedder returns nothing", async () => {
    const result = await episodeAttachGate(RICH, [{ episodeId: "ep_near" }], {
      ...opts,
      embed: async () => [],
    });
    expect(result.enabled).toBe(false);
    expect(result.decision).toBe("escalate");
    expect(result.scores).toEqual([]);
  });
});
