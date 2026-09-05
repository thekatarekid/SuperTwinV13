// ===========================================================================
// The cross-encoder reranker (V6 P1 S2.4) — the registry entry, the
// deterministic fallback, the selection rules and the runtime adapter against
// the transformers stub. Zero model calls, no network.
// ===========================================================================

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const tmpRoot = mkdtempSync(join(tmpdir(), "st-reranker-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");
delete process.env.SUPERTWIN_RERANKER;
delete process.env.SUPERTWIN_EMBEDDING_RUNTIME;
delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;

const { RERANKER_MODEL, RERANKER_MODELS, EMBEDDING_MODELS, findRerankerModel, findEmbeddingModel } = await import(
  "./model-registry.js"
);
const { embeddingModelFilePath, embeddingModelPresent } = await import("./embedder.js");
const {
  LEXICAL_OVERLAP_RERANKER,
  RERANK_BATCH,
  forgetReranker,
  getReranker,
  rerankerStatus,
  setReranker,
  splitLogits,
} = await import("./reranker.js");

const modelDir = join(tmpRoot, "models");

function stageFiles(): void {
  for (const file of RERANKER_MODEL.files) {
    const path = embeddingModelFilePath(file.path, RERANKER_MODEL);
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "w"));
    truncateSync(path, file.bytes);
  }
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  forgetReranker();
});

afterEach(() => {
  delete process.env.SUPERTWIN_RERANKER;
  delete process.env.SUPERTWIN_EMBEDDING_RUNTIME;
  delete process.env.SUPERTWIN_EMBEDDING_MODEL_DIR;
  rmSync(modelDir, { recursive: true, force: true });
  forgetReranker();
});

describe("the registry entry", () => {
  it("is a reranker, pinned file by file, and not an encoder", () => {
    expect(RERANKER_MODEL.kind).toBe("reranker");
    expect(RERANKER_MODEL.id).toBe("Xenova/bge-reranker-base");
    expect(RERANKER_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(RERANKER_MODEL.files.length).toBeGreaterThan(0);
    for (const f of RERANKER_MODEL.files) {
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(RERANKER_MODEL.files.some((f) => f.path === "onnx/model_quantized.onnx")).toBe(true);
    // A cross-encoder takes the pair as-is.
    expect(RERANKER_MODEL.queryPrefix).toBe("");
    expect(RERANKER_MODEL.passagePrefix).toBe("");
    // Its own list; never offered as an encoder.
    expect(RERANKER_MODELS).toContain(RERANKER_MODEL);
    expect(EMBEDDING_MODELS.some((m) => m.id === RERANKER_MODEL.id)).toBe(false);
    expect(findRerankerModel(RERANKER_MODEL.id)).toBe(RERANKER_MODEL);
    expect(findEmbeddingModel(RERANKER_MODEL.id)).toBeNull();
    expect(findRerankerModel("nope")).toBeNull();
  });

  it("is located and checked for presence the way an encoder is", () => {
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    expect(embeddingModelPresent(RERANKER_MODEL)).toBe(false);
    stageFiles();
    expect(embeddingModelPresent(RERANKER_MODEL)).toBe(true);
    truncateSync(embeddingModelFilePath("onnx/model_quantized.onnx", RERANKER_MODEL), 10);
    expect(embeddingModelPresent(RERANKER_MODEL)).toBe(false);
  });
});

describe("the deterministic fallback", () => {
  it("scores overlap in 0..1, monotone, and 0 for nothing in common", async () => {
    const scores = await LEXICAL_OVERLAP_RERANKER.score("did we book the villa", [
      "yes we book the villa tomorrow",
      "villa booked",
      "weather is fine",
      "",
    ]);
    expect(scores).toHaveLength(4);
    for (const s of scores) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
    expect(scores[0]).toBeGreaterThan(scores[1]);
    expect(scores[1]).toBeGreaterThan(scores[2]);
    expect(scores[2]).toBe(0);
    expect(scores[3]).toBe(0);
    // The same inputs give the same numbers — it is a fixture, not a model.
    expect(await LEXICAL_OVERLAP_RERANKER.score("did we book the villa", ["villa booked"])).toEqual([scores[1]]);
    expect(await LEXICAL_OVERLAP_RERANKER.score("", ["anything"])).toEqual([0]);
  });

  it("a shorter passage with the same overlap outranks a longer one", async () => {
    const [short, long] = await LEXICAL_OVERLAP_RERANKER.score("villa advance", [
      "villa advance paid",
      "villa advance paid and here is a long unrelated paragraph about many other things that happened",
    ]);
    expect(short).toBeGreaterThan(long);
  });
});

describe("selection", () => {
  it("a registered instance wins over everything", async () => {
    const mine = { model: "mine", async score(_q: string, p: readonly string[]) { return p.map(() => 0.5); } };
    setReranker(mine);
    expect(await getReranker()).toBe(mine);
    expect(rerankerStatus()).toMatchObject({ availability: "ready", model: "mine" });
    setReranker(null);
    expect(rerankerStatus().availability).toBe("unknown");
  });

  it("SUPERTWIN_RERANKER=off is none; =lexical is the deterministic one", async () => {
    process.env.SUPERTWIN_RERANKER = "off";
    expect(await getReranker()).toBeNull();
    expect(rerankerStatus().availability).toBe("disabled");

    process.env.SUPERTWIN_RERANKER = "lexical";
    expect(await getReranker()).toBe(LEXICAL_OVERLAP_RERANKER);
    expect(rerankerStatus().availability).toBe("ready");
  });

  it("with no weights on disk it is null, says so, and never looks for a runtime", async () => {
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = "@supertwin/no-such-runtime";
    expect(await getReranker()).toBeNull();
    const status = rerankerStatus();
    expect(status.availability).toBe("no-model");
    expect(status.reason).toContain("not downloaded yet");
    expect(status.model).toBe(RERANKER_MODEL.id);
  });

  it("with weights but no runtime it is null once, and remembers", async () => {
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = "@supertwin/no-such-runtime";
    stageFiles();
    expect(await getReranker()).toBeNull();
    expect(rerankerStatus().availability).toBe("no-runtime");
    expect(rerankerStatus().reason).toContain("@supertwin/no-such-runtime");
    expect(await getReranker()).toBeNull();
  });
});

describe("the runtime adapter", () => {
  const stubPath = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "transformers-runtime-stub.mjs");

  it("loads tokenizer + classification head locally, hands pairs over in order, and sigmoids the logits", async () => {
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = pathToFileURL(stubPath).href;
    stageFiles();

    const reranker = await getReranker();
    expect(reranker).toBeTruthy();
    expect(reranker!.model).toBe(RERANKER_MODEL.id);
    expect(rerankerStatus().availability).toBe("ready");

    const stub = (globalThis as { __transformersStub?: { env: Record<string, unknown>; calls: unknown[] } })
      .__transformersStub!;
    expect(stub.env.cacheDir).toBe(modelDir);
    expect(stub.env.allowLocalModels).toBe(true);
    expect(stub.env.allowRemoteModels).toBe(false);
    expect(stub.calls).toContainEqual({ tokenizer: RERANKER_MODEL.id });
    expect(stub.calls).toContainEqual({ classifier: RERANKER_MODEL.id, options: { dtype: "q8" } });

    const before = stub.calls.length;
    const scores = await reranker!.score("villa", ["a", "a much longer passage here", ""]);
    expect(scores).toHaveLength(3);
    // The stub's logit is (passage length − query length)/10 → sigmoid: monotone in length.
    expect(scores[1]).toBeGreaterThan(scores[0]);
    expect(scores[0]).toBeGreaterThan(scores[2]);
    for (const s of scores) {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    }
    const tokenize = stub.calls.slice(before).find((c) => (c as { tokenize?: unknown }).tokenize) as {
      tokenize: string[];
      options: { text_pair: string[]; padding: boolean; truncation: boolean };
    };
    expect(tokenize.tokenize).toEqual(["villa", "villa", "villa"]);
    expect(tokenize.options.text_pair).toEqual(["a", "a much longer passage here", ""]);
    expect(tokenize.options).toMatchObject({ padding: true, truncation: true });
  });

  it("batches long windows and truncates a passage the head could not read anyway", async () => {
    process.env.SUPERTWIN_EMBEDDING_MODEL_DIR = modelDir;
    process.env.SUPERTWIN_EMBEDDING_RUNTIME = pathToFileURL(stubPath).href;
    stageFiles();
    const reranker = (await getReranker())!;
    const stub = (globalThis as { __transformersStub?: { calls: unknown[] } }).__transformersStub!;
    const before = stub.calls.length;
    const passages = Array.from({ length: RERANK_BATCH * 2 + 3 }, (_, i) => `p${i} ${"x".repeat(i === 0 ? 5000 : 3)}`);
    const scores = await reranker.score("q", passages);
    expect(scores).toHaveLength(passages.length);
    const tokenizes = stub.calls.slice(before).filter((c) => (c as { tokenize?: unknown }).tokenize) as {
      options: { text_pair: string[] };
    }[];
    expect(tokenizes).toHaveLength(3);
    expect(tokenizes[0].options.text_pair[0].length).toBe(1200);
  });

  it("splitLogits refuses a shape that disagrees with the pair count", () => {
    expect(splitLogits({ data: new Float32Array([0, 100, -100]), dims: [3, 1] }, 3)).toEqual([0.5, 1, expect.closeTo(0, 6)]);
    expect(() => splitLogits({ data: new Float32Array(2), dims: [2, 1] }, 3)).toThrow(/2 logits for 3 pairs/);
  });
});
