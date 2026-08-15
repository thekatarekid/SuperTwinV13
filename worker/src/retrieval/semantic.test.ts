// Semantic retrieval (docs/v6-spec.md §1, tier 3).
//
// The real encoder is 129 MB the user downloads, so what runs here is a
// stand-in: a four-concept bag, honest about being one, and enough to prove
// that a hit reached by MEANING alone lands in the block. Everything around it
// is the real thing — the incremental index, the model/dim isolation, the
// search, the switch, and the adapter that drives the runtime, against a stub
// module with the runtime's shape.

process.env.TZ = "Asia/Kolkata";

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-semantic-"));
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;

const { closeDb, getDb } = await import("../db/connection.js");
const { runMigrations } = await import("../db/index.js");
const { countEventEmbeddings, putEventEmbeddings, readEventEmbeddings } = await import(
  "../db/embeddings.js"
);
const {
  cosine,
  embeddableText,
  indexSemanticBatch,
  resetSemanticCacheForTests,
  semanticSearch,
  semanticSearchWithin,
  semanticStatus,
} = await import("./semantic.js");
const { readChannelEventIds } = await import("../db/retrieval.js");
const {
  getEmbedder,
  forgetEmbedder,
  setEmbedder,
  splitTensor,
  semanticEnabled,
  embeddingModelPresent,
  EMBEDDING_MODEL,
  embeddingModelFilePath,
} = await import("./embedder.js");
const { setSemanticRetrievalEnabled, RETRIEVAL_SEMANTIC_ENABLED_KEY } = await import(
  "../store/store.js"
);
const { retrieveContext } = await import("./retrieve.js");
const { formatContextBlock } = await import("./format.js");

// ---------------------------------------------------------------------------
// A stand-in encoder: four concepts, one dimension each. Not a language model —
// a fixture that behaves like one for the two words this test needs it to.
// ---------------------------------------------------------------------------

const CONCEPTS = ["plan", "food", "movie", "house"] as const;

const LEXICON: Record<string, number[]> = {
  sunday: [0.9, 0.2, 0, 0],
  plans: [1, 0, 0, 0],
  plan: [1, 0, 0, 0],
  booked: [0.8, 0.2, 0.2, 0],
  oye: [0.3, 0.9, 0, 0],
  kake: [0.3, 0.9, 0, 0],
  lunch: [0.4, 1, 0, 0],
  imax: [0, 0, 1, 0],
  odyssey: [0, 0, 0.9, 0],
  ghar: [0, 0, 0, 1],
  flat: [0, 0, 0, 1],
};

const conceptEmbedder = {
  model: "test-concept-v1",
  dim: CONCEPTS.length,
  async embed(texts: readonly string[], role: "query" | "passage") {
    embedCalls.push({ role, texts: [...texts] });
    return texts.map((text) => {
      const v = new Float32Array(CONCEPTS.length);
      for (const word of text.toLowerCase().split(/[^a-z]+/)) {
        const weights = LEXICON[word];
        if (!weights) continue;
        weights.forEach((w, i) => {
          v[i] += w;
        });
      }
      return v;
    });
  },
};

let embedCalls: { role: string; texts: string[] }[] = [];

// ---------------------------------------------------------------------------

const modelDir = join(tmpRoot, "models");

/**
 * Weights the presence check accepts: the pinned names at the pinned lengths.
 * Sparse — 118 MB of holes costs nothing and takes no time, and nothing below
 * the runtime adapter ever opens them.
 */
function stageModelFiles(): void {
  for (const file of EMBEDDING_MODEL.files) {
    const path = embeddingModelFilePath(file.path);
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "w"));
    truncateSync(path, file.bytes);
  }
}

function clearModelFiles(): void {
  rmSync(join(modelDir), { recursive: true, force: true });
}

const CH = "ch-weekend";
const NOW = new Date("2026-07-31T09:00:00Z");

function addEvent(id: string, text: string, ts: string, kind = "message"): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
       VALUES (?, 'whatsapp', 'whatsapp', ?, 'ac-1', ?, ?, ?, ?)`,
    )
    .run(id, CH, ts, kind, text, id);
}

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  db.prepare(
    `INSERT INTO channels (id, source_id, name, kind) VALUES (?, 'whatsapp', 'Weekend lunches', 'group')`,
  ).run(CH);
  db.prepare(
    `INSERT INTO actors (id, source_id, display_name) VALUES ('ac-1', 'whatsapp', 'Rahul')`,
  ).run();

  addEvent("evt-booked", "booked oye kake", "2026-07-28T15:37:20.000Z");
  addEvent("evt-imax", "i booked sat imax koramangala", "2026-07-27T09:21:36.000Z");
  addEvent("evt-flat", "pasand aaya ghar koi ?", "2026-07-25T16:42:00.000Z");
  addEvent("evt-react", "🙏", "2026-07-29T06:51:52.000Z", "reaction");
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  embedCalls = [];
  forgetEmbedder();
  resetSemanticCacheForTests();
});

// ===========================================================================

describe("with no encoder present", () => {
  it("says so without even looking for a runtime — the state it ships in", async () => {
    expect(await getEmbedder()).toBeNull();
    expect(semanticStatus().availability).toBe("disabled");
    expect(semanticStatus().enabled).toBe(false);
  });

  it("searches nothing, indexes nothing, and says which half is missing", async () => {
    process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "1";
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = "@supertwin/no-such-runtime";
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    stageModelFiles();

    expect(await semanticSearch("sunday plans")).toEqual([]);
    expect(await indexSemanticBatch()).toBe(0);

    const status = semanticStatus();
    expect(status.availability).toBe("no-runtime");
    expect(status.reason).toContain("@supertwin/no-such-runtime");
    expect(status.indexed).toBe(0);
    expect(status.embeddable).toBeGreaterThan(0);

    clearModelFiles();
    delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
    delete process.env.SUPERTWIN_EMBEDDING_RUNTIME;
    delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
  });

  it("does not reach a runtime at all while the weights are missing", async () => {
    process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "1";
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;

    expect(await getEmbedder()).toBeNull();
    const status = semanticStatus();
    expect(status.availability).toBe("no-model");
    expect(status.reason).toContain("not downloaded yet");

    delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
    delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
  });

  it("is on by default once the weights are on disk, and off before that", () => {
    // The measured state of the live database: 0 vectors against 595
    // embeddable, because nothing had ever written the switch and an unset row
    // read as "off" — so SEMANTIC_WEIGHT multiplied zero on every query.
    expect(embeddingModelPresent()).toBe(false);
    expect(semanticEnabled()).toBe(false);

    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    stageModelFiles();
    expect(semanticEnabled()).toBe(true);

    // A choice always outranks the default, in both directions.
    setSemanticRetrievalEnabled(false);
    expect(semanticEnabled()).toBe(false);
    setSemanticRetrievalEnabled(true);
    expect(semanticEnabled()).toBe(true);

    getDb().prepare(`DELETE FROM app_state WHERE key = ?`).run(
      RETRIEVAL_SEMANTIC_ENABLED_KEY,
    );
    clearModelFiles();
    delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
  });

  it("retrieval is byte-for-byte the same with the tier off", () => {
    const withoutSeeds = retrieveContext({ query: "booked", now: NOW });
    const withEmptySeeds = retrieveContext({
      query: "booked",
      now: NOW,
      semanticSeeds: [],
    });
    expect(formatContextBlock(withEmptySeeds)).toBe(formatContextBlock(withoutSeeds));
  });
});

describe("with an encoder", () => {
  beforeEach(() => {
    setEmbedder(conceptEmbedder);
  });

  it("indexes incrementally: a pass costs what arrived since the last one", async () => {
    const key = { model: conceptEmbedder.model, dim: conceptEmbedder.dim };
    expect(await indexSemanticBatch()).toBe(3); // the reaction is not embeddable
    expect(countEventEmbeddings(key)).toBe(3);

    // Nothing new: nothing embedded, and the encoder is not even called.
    embedCalls = [];
    expect(await indexSemanticBatch()).toBe(0);
    expect(embedCalls).toEqual([]);

    addEvent("evt-new", "sunday lunch chalna hai kahin?", "2026-07-30T09:00:00.000Z");
    expect(await indexSemanticBatch()).toBe(1);
    expect(embedCalls[0].texts).toEqual(["sunday lunch chalna hai kahin?"]);
    expect(embedCalls[0].role).toBe("passage");

    getDb().prepare(`DELETE FROM events WHERE id = 'evt-new'`).run();
  });

  it("reaches a message by meaning that shares no word with the question", async () => {
    await indexSemanticBatch();
    resetSemanticCacheForTests();

    const seeds = await semanticSearch("sunday plans", 3);
    expect(seeds[0].eventId).toBe("evt-booked");
    expect(seeds[0].similarity).toBeGreaterThan(0.5);
    // The query is embedded as a query, not as a passage.
    expect(embedCalls.at(-1)).toMatchObject({ role: "query", texts: ["sunday plans"] });

    // …and the message about a flat is nowhere near it.
    expect(seeds.map((s) => s.eventId)).not.toContain("evt-flat");
  });

  it("a semantic seed brings its chat into the block", async () => {
    await indexSemanticBatch();
    resetSemanticCacheForTests();
    const seeds = await semanticSearch("sunday plans", 3);

    // Lexically "sunday plans" matches nothing in this DB at all.
    const lexicalOnly = retrieveContext({ query: "sunday plans", now: NOW });
    expect(lexicalOnly.sections).toEqual([]);

    const withSemantic = retrieveContext({
      query: "sunday plans",
      now: NOW,
      semanticSeeds: seeds,
    });
    const block = formatContextBlock(withSemantic);
    expect(block).toContain("evt-booked");
    expect(block).toContain("booked oye kake");
    expect(withSemantic.semanticSeedIds).toContain("evt-booked");
  });

  it("a model change invalidates rather than mixes", async () => {
    await indexSemanticBatch();
    const other = { ...conceptEmbedder, model: "test-concept-v2" };
    setEmbedder(other);
    resetSemanticCacheForTests();

    // v2 cannot see v1's vectors: a distance between two embedding spaces is
    // not a distance.
    expect(await semanticSearch("sunday plans")).toEqual([]);
    expect(countEventEmbeddings({ model: other.model, dim: other.dim })).toBe(0);

    // They come back from the claim, so the index rebuilds itself in the
    // background instead of demanding one big re-index.
    expect(await indexSemanticBatch()).toBe(3);
    resetSemanticCacheForTests();
    expect((await semanticSearch("sunday plans"))[0].eventId).toBe("evt-booked");

    setEmbedder(conceptEmbedder);
  });

  it("every claimed event leaves with a vector, even an empty-looking one", async () => {
    // TRIM() in SQL strips spaces; it does not strip newlines, so twelve of
    // them clear the length bar and collapse to nothing in JS. A row that is
    // claimed and never stored is claimed again forever, in front of
    // everything behind it.
    addEvent("evt-blank", "\n".repeat(12), "2026-07-31T01:00:00.000Z");
    await indexSemanticBatch();
    const key = { model: conceptEmbedder.model, dim: conceptEmbedder.dim };
    expect(readEventEmbeddings(key).map((r) => r.eventId)).toContain("evt-blank");
    expect(await indexSemanticBatch()).toBe(0);

    getDb().prepare(`DELETE FROM events WHERE id = 'evt-blank'`).run();
  });
});

describe("what gets embedded", () => {
  it("composes the parts a message carries, and leaves the scraped page out", () => {
    expect(
      embeddableText({
        id: "e",
        ts: null,
        channelId: null,
        kind: "message",
        text: "wahan bhi chal   sakte hai",
        mediaDescription: "A printed menu",
        transcript: "kal shaam paanch baje",
        linkTitle: "Swiggy Dineout",
        linkDescription: "FLAT discounts",
        replyToText: "Oye kake nahi jaana ?",
      }),
    ).toBe(
      "re: Oye kake nahi jaana ? · wahan bhi chal sakte hai · kal shaam paanch baje · " +
        "A printed menu · Swiggy Dineout · FLAT discounts",
    );
  });

  it("is bounded — one vector cannot hold a 40 KB article", () => {
    const long = embeddableText({
      id: "e",
      ts: null,
      channelId: null,
      kind: "message",
      text: "x".repeat(50_000),
      mediaDescription: null,
      transcript: null,
      linkTitle: null,
      linkDescription: null,
      replyToText: null,
    });
    expect(long.length).toBeLessThanOrEqual(1200);
  });
});

// ---------------------------------------------------------------------------
// Scoring. The number that leaves here is spent by the blend in retrieve.ts as
// `SEMANTIC_WEIGHT * similarity`, so a model whose cosines all sit at 0.8 must
// not hand every event most of a lexical hit's score. Measured on 558 real
// messages, e5's cosines against any query span about 0.02 — this is the test
// for the corpus-relative scoring that turns that into something spendable.
// ---------------------------------------------------------------------------

describe("scoring a query against a corpus", () => {
  const DIM = 4;
  const CH2 = "ch-crowd";

  /**
   * A corpus wide enough to calibrate against: 200 near-identical vectors, and
   * three that lean towards the probe by increasing amounts.
   */
  function seedCrowd(): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO channels (id, source_id, name, kind) VALUES (?, 'whatsapp', 'Crowd', 'group')`,
    ).run(CH2);
    for (let i = 0; i < 200; i++) {
      db.prepare(
        `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
         VALUES (?, 'whatsapp', 'whatsapp', ?, 'ac-1', '2026-07-20T00:00:00.000Z', 'message', ?, ?)`,
      ).run(`crowd-${i}`, CH2, `filler message number ${i}`, `crowd-${i}`);
    }
  }

  /**
   * A unit vector whose cosine against the probe is exactly `c`, so the
   * distribution under test is the one written here rather than one that falls
   * out of some geometry.
   */
  function leaning(c: number): number[] {
    return [c, Math.sqrt(1 - c * c), 0, 0];
  }

  function put(id: string, c: number): void {
    putEventEmbeddings([
      {
        eventId: id,
        model: "geom-v1",
        dim: DIM,
        vector: Float32Array.from(leaning(c)),
      },
    ]);
  }

  const probeEmbedder = {
    model: "geom-v1",
    dim: DIM,
    async embed() {
      return [Float32Array.from([1, 0, 0, 0])];
    },
  };

  /** Cosines around 0.53 with a deviation of 0.02 — e5's shape, in miniature. */
  function spreadCorpus(): void {
    for (let i = 0; i < 200; i++) put(`crowd-${i}`, 0.5 + (i % 7) * 0.01);
    put("evt-booked", 0.62); // ~4.5σ
    put("evt-imax", 0.585); // ~2.7σ
    put("evt-flat", 0.55); // ~1σ — closer than most, and still not a match
  }

  beforeAll(() => {
    seedCrowd();
  });

  beforeEach(() => {
    setEmbedder(probeEmbedder);
    spreadCorpus();
    resetSemanticCacheForTests();
  });

  it("keeps only what stands out from the corpus, not what clears a fixed bar", async () => {
    const seeds = await semanticSearch("anything", 10);
    // Every one of the 203 rows is well over MIN_SIMILARITY on raw cosine, and
    // evt-flat is nearer the probe than any filler — being near is not the test.
    expect(seeds.map((s) => s.eventId)).toEqual(["evt-booked", "evt-imax"]);
  });

  it("scores 0..1, so a seed cannot outweigh a lexical hit by accident", async () => {
    const seeds = await semanticSearch("anything", 10);
    expect(seeds[0].similarity).toBeGreaterThan(seeds[1].similarity);
    for (const seed of seeds) {
      expect(seed.similarity).toBeGreaterThan(0);
      expect(seed.similarity).toBeLessThanOrEqual(1);
    }
  });

  it("finds nothing when every vector is the same distance away", async () => {
    // Nothing is nearer than anything else, which is not the same as everything
    // being a match — the state a fixed threshold gets wrong in both directions.
    for (let i = 0; i < 200; i++) put(`crowd-${i}`, 0.5);
    put("evt-booked", 0.5);
    put("evt-imax", 0.5);
    put("evt-flat", 0.5);
    resetSemanticCacheForTests();

    expect(await semanticSearch("anything", 10)).toEqual([]);
  });
});

describe("scoring a query against ONE chat", () => {
  const DIM = 4;
  const QUIET = "ch-quiet";
  const LOUD = "ch-loud";
  const SIGNAL = "quiet-signal";

  /** A unit vector whose cosine against the probe is exactly `c`. */
  function put(id: string, c: number): void {
    putEventEmbeddings([
      {
        eventId: id,
        model: "pool-v1",
        dim: DIM,
        vector: Float32Array.from([c, Math.sqrt(1 - c * c), 0, 0]),
      },
    ]);
  }

  const probeEmbedder = {
    model: "pool-v1",
    dim: DIM,
    async embed() {
      return [Float32Array.from([1, 0, 0, 0])];
    },
  };

  /**
   * Two chats with different distributions. One row of the quiet chat is the
   * most unusual thing anyone in it ever said and is completely unremarkable
   * against the corpus, because the loud chat sits above it — which is the case
   * the corpus-wide gate gets wrong on a question that named the quiet chat.
   */
  beforeAll(() => {
    const db = getDb();
    const channel = db.prepare(
      `INSERT INTO channels (id, source_id, name, kind) VALUES (?, 'whatsapp', ?, 'group')`,
    );
    channel.run(QUIET, "Quiet");
    channel.run(LOUD, "Loud");
    const event = db.prepare(
      `INSERT INTO events (id, source_id, source_type, channel_id, actor_id, ts, kind, text, external_id)
       VALUES (?, 'whatsapp', 'whatsapp', ?, 'ac-1', '2026-07-20T00:00:00.000Z', 'message', ?, ?)`,
    );
    for (let i = 0; i < 79; i++) event.run(`quiet-${i}`, QUIET, `quiet ${i}`, `quiet-${i}`);
    event.run(SIGNAL, QUIET, "the one thing", SIGNAL);
    for (let i = 0; i < 120; i++) event.run(`loud-${i}`, LOUD, `loud ${i}`, `loud-${i}`);
  });

  beforeEach(() => {
    setEmbedder(probeEmbedder);
    for (let i = 0; i < 79; i++) put(`quiet-${i}`, 0.5 + (i % 6) * 0.001);
    put(SIGNAL, 0.55);
    for (let i = 0; i < 120; i++) put(`loud-${i}`, 0.56 + (i % 7) * 0.01);
    resetSemanticCacheForTests();
  });

  it("finds what stands out in the chat the question named, not in the corpus", async () => {
    const corpus = await semanticSearch("anything", 10);
    expect(corpus.map((s) => s.eventId)).not.toContain(SIGNAL);

    const within = await semanticSearchWithin(
      "anything",
      readChannelEventIds([QUIET]),
      10,
    );
    expect(within.map((s) => s.eventId)).toEqual([SIGNAL]);
  });

  it("stays inside the pool it was given", async () => {
    const within = await semanticSearchWithin(
      "anything",
      readChannelEventIds([QUIET]),
      10,
    );
    expect(within.every((s) => s.eventId.startsWith("quiet") || s.eventId === SIGNAL)).toBe(
      true,
    );
  });

  it("refuses a pool too small to have a distribution", async () => {
    // Under MIN_CALIBRATION_ROWS a mean and a deviation describe nothing, and a
    // chat that small is small enough to be handed over whole anyway.
    const tiny = readChannelEventIds([QUIET]).slice(0, 20);
    expect(await semanticSearchWithin("anything", tiny, 10)).toEqual([]);
    expect(await semanticSearchWithin("anything", [], 10)).toEqual([]);
  });

  it("says nothing at all with the tier off", async () => {
    forgetEmbedder();
    resetSemanticCacheForTests();
    expect(await semanticSearchWithin("anything", readChannelEventIds([QUIET]))).toEqual(
      [],
    );
  });
});

describe("cosine", () => {
  it("is 1 for the same direction and 0 for orthogonal or empty", () => {
    const a = Float32Array.from([1, 0, 0, 0]);
    const b = Float32Array.from([3, 0, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(1);
    expect(cosine(a, Float32Array.from([0, 1, 0, 0]))).toBeCloseTo(0);
    expect(cosine(a, new Float32Array(4))).toBe(0);
    expect(cosine(a, Float32Array.from([1, 0]))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The runtime adapter, against a stub with the real package's shape: what is
// verified is that OUR side asks for the right thing (task, dtype, pooling,
// e5's prefixes) and reshapes what comes back. Driving the real 129 MB encoder
// belongs in a probe, not in a unit suite.
// ---------------------------------------------------------------------------

describe("the runtime adapter", () => {
  const stubPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "__fixtures__",
    "transformers-runtime-stub.mjs",
  );

  it("loads by specifier, pins the cache dir, and never asks to download", async () => {
    process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "1";
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = pathToFileURL(stubPath).href;
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    stageModelFiles();
    forgetEmbedder();

    const embedder = await getEmbedder();
    expect(embedder).toBeTruthy();
    expect(embedder!.model).toBe("Xenova/multilingual-e5-small");
    expect(embedder!.dim).toBe(384);

    const stub = (
      globalThis as {
        __transformersStub?: { env: Record<string, unknown>; calls: unknown[] };
      }
    ).__transformersStub!;
    expect(stub.env.cacheDir).toBe(modelDir);
    expect(stub.env.allowLocalModels).toBe(true);
    // The download route owns fetching, and it verifies digests. Nothing here
    // may reach the network, in a chat turn or out of one.
    expect(stub.env.allowRemoteModels).toBe(false);
    expect(stub.calls[0]).toMatchObject({
      task: "feature-extraction",
      model: "Xenova/multilingual-e5-small",
      options: { dtype: "q8" },
    });

    const vectors = await embedder!.embed(["booked oye kake"], "query");
    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(384);
    // E5 is trained with these prefixes; dropping them costs real accuracy.
    expect(stub.calls[1]).toMatchObject({
      input: ["query: booked oye kake"],
      opts: { pooling: "mean", normalize: true },
    });
    await embedder!.embed(["booked oye kake"], "passage");
    expect((stub.calls[2] as { input: string[] }).input).toEqual([
      "passage: booked oye kake",
    ]);

    clearModelFiles();
    delete process.env.SUPERTWIN_EMBEDDING_RUNTIME;
    delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
    delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
    forgetEmbedder();
  });

  it("refuses to load when one weight file is the wrong size", async () => {
    process.env.SUPERTWIN_SEMANTIC_RETRIEVAL = "1";
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = pathToFileURL(stubPath).href;
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    stageModelFiles();
    // A half-written graph loads and answers; it just answers in a space where
    // nothing looks wrong. Short is absent, not present.
    truncateSync(embeddingModelFilePath("onnx/model_quantized.onnx"), 4096);
    forgetEmbedder();

    expect(await getEmbedder()).toBeNull();
    expect(semanticStatus().availability).toBe("no-model");

    clearModelFiles();
    delete process.env.SUPERTWIN_EMBEDDING_RUNTIME;
    delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
    delete process.env.SUPERTWIN_SEMANTIC_RETRIEVAL;
    forgetEmbedder();
  });

  it("rejects a tensor whose shape disagrees with the model's dimension", () => {
    expect(splitTensor({ data: new Float32Array(8), dims: [2, 4] }, 2, 4)).toHaveLength(2);
    expect(() => splitTensor({ data: new Float32Array(7), dims: [2, 4] }, 2, 4)).toThrow(
      /expected 8/,
    );
  });
});
