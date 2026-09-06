// ===========================================================================
// One forward pass must not freeze the worker.
//
// THE DEFECT THIS PINS. `onnxruntime-node` has no asynchronous run. Its
// dist/backend.js is a synchronous native call wrapped in a `setImmediate`, so
// the inference happens ON THE NODE MAIN THREAD and every HTTP route, the
// scheduler and the dispatch lane are frozen for its whole duration. With the
// indexer's batch of 32 and EmbeddingGemma-300M active, that is 20-30 seconds
// at a time — measured on the user's own machine at the V6P1S6d gate, where
// consecutive /api/health pings read 10.4 / 21.2 / 31.5 / 26.3 s and then
// 0.0006 s, and `sample(1)` put 5447 of 5447 main-thread samples inside
// `CheckImmediate -> InferenceSessionWrap::Run -> MlasGemmBatch`.
//
// `wrapPipeline` therefore decouples the batch the MODEL sees from the batch
// the caller asks for, sizes it from the last pass's measured cost, and yields
// between passes. These cases hold the three things that must stay true: the
// answer is unchanged, no pass is allowed to be long, and the loop really does
// get a turn in between.
// ===========================================================================

import { describe, expect, it } from "vitest";

import {
  nextForwardBatch,
  wrapPipeline,
  type FeaturePipeline,
  type FeatureTensor,
} from "./embedder.js";
import type { EmbeddingModelSpec } from "./model-registry.js";

const DIM = 4;

const SPEC = {
  id: "test/model",
  dim: DIM,
  source: "https://example.invalid/test/model",
  revision: "0".repeat(40),
  files: [],
  queryPrefix: "query: ",
  passagePrefix: "passage: ",
  dtype: "q8",
  label: "Test",
  note: "",
  bundled: false,
  recommended: false,
} as unknown as EmbeddingModelSpec;

/**
 * Burn wall time WITHOUT yielding, which is what `session.run()` does. A
 * `setTimeout` here would make every case pass against the unfixed code: the
 * defect is that the pass is SYNCHRONOUS, so the stub has to be too.
 */
function spin(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* the main thread, held — exactly as MlasGemmBatch holds it */
  }
}

/**
 * A pipeline that answers with one recognisable vector per input — the first
 * lane carries the input's own index, so a reordered or duplicated answer is
 * visible — and records the size of every pass it was handed.
 */
function stubPipeline(perTextMs: number): {
  pipe: FeaturePipeline;
  sizes: number[];
  seen: string[];
} {
  const sizes: number[] = [];
  const seen: string[] = [];
  const pipe: FeaturePipeline = async (input) => {
    sizes.push(input.length);
    if (perTextMs > 0) spin(perTextMs * input.length);
    const data = new Float32Array(input.length * DIM);
    for (let i = 0; i < input.length; i++) {
      seen.push(input[i]);
      data[i * DIM] = seen.length - 1; // a unique, order-revealing value
    }
    return { data, dims: [input.length, DIM] } satisfies FeatureTensor;
  };
  return { pipe, sizes, seen };
}

describe("the forward pass is sub-batched and yields", () => {
  it("a slow model never sees the caller's whole batch at once", async () => {
    // 30 ms per text against the 250 ms budget: the first pass tries 8, and
    // every pass after it is sized from measurement. What matters is that 32
    // never goes through in one call, which is the 30-second freeze.
    const { pipe, sizes } = stubPipeline(30);
    const embedder = wrapPipeline(pipe, SPEC);

    const out = await embedder.embed(Array.from({ length: 32 }, (_, i) => `t${i}`), "passage");

    expect(out).toHaveLength(32);
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(8);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(32);
  });

  it("the answer is the same answer — same count, same order, one vector per text", async () => {
    const { pipe, seen } = stubPipeline(5);
    const embedder = wrapPipeline(pipe, SPEC);

    const texts = Array.from({ length: 20 }, (_, i) => `text-${i}`);
    const out = await embedder.embed(texts, "passage");

    expect(out).toHaveLength(20);
    // The stub stamps each vector with its global position; sub-batching must
    // not shuffle, drop or repeat one.
    expect(out.map((v) => v[0])).toEqual(texts.map((_, i) => i));
    // And the role's prefix is still applied, once, to every text.
    expect(seen).toEqual(texts.map((t) => `passage: ${t}`));
  });

  it("the query role keeps its own prefix", async () => {
    const { pipe, seen } = stubPipeline(0);
    const embedder = wrapPipeline(pipe, SPEC);
    await embedder.embed(["who is rohan"], "query");
    expect(seen).toEqual(["query: who is rohan"]);
  });

  it("the event loop gets a turn between passes — a queued callback runs mid-embed", async () => {
    // This is the whole point: an HTTP request that arrives during the batch
    // must be answered during the batch, not after it.
    const { pipe } = stubPipeline(20);
    const embedder = wrapPipeline(pipe, SPEC);

    let ranAt: "during" | "after" | null = null;
    const pending = embedder.embed(Array.from({ length: 24 }, (_, i) => `t${i}`), "passage");
    setImmediate(() => {
      ranAt = ranAt ?? "during";
    });
    await pending;
    ranAt = ranAt ?? "after";

    expect(ranAt).toBe("during");
  });

  it("a single text is one pass and no yield", async () => {
    const { pipe, sizes } = stubPipeline(30);
    const embedder = wrapPipeline(pipe, SPEC);
    const out = await embedder.embed(["only one"], "passage");
    expect(out).toHaveLength(1);
    expect(sizes).toEqual([1]);
  });

  it("an empty ask never reaches the model", async () => {
    const { pipe, sizes } = stubPipeline(0);
    const embedder = wrapPipeline(pipe, SPEC);
    expect(await embedder.embed([], "passage")).toEqual([]);
    expect(sizes).toEqual([]);
  });

  it("a fast model pays nothing — the batch climbs back to the cap", async () => {
    // The fix must not slow down the small bundled encoder to protect the
    // large one: a pass that measures ~0 ms doubles the next.
    const { pipe, sizes } = stubPipeline(0);
    const embedder = wrapPipeline(pipe, SPEC);
    await embedder.embed(Array.from({ length: 200 }, (_, i) => `t${i}`), "passage");
    expect(Math.max(...sizes)).toBe(32); // FORWARD_BATCH_MAX
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(200);
  });

  it("a wrong-shaped tensor still throws, per sub-batch", async () => {
    // splitTensor is what refuses a vector in the wrong space; sub-batching
    // must not route around it.
    const pipe: FeaturePipeline = async (input) => ({
      data: new Float32Array(input.length * (DIM + 1)),
      dims: [input.length, DIM + 1],
    });
    const embedder = wrapPipeline(pipe, SPEC);
    await expect(embedder.embed(["a", "b"], "passage")).rejects.toThrow(/expected/);
  });
});

describe("nextForwardBatch", () => {
  it("sizes the next pass at the budget, from the last pass's cost", () => {
    // 8 texts in 800 ms = 100 ms each; 250 ms of budget buys 2.5 -> 3.
    expect(nextForwardBatch(8, 800, 250, 32)).toBe(3);
  });

  it("never goes below one — one text is the floor of what this can do", () => {
    // A 300M model at ~900 ms/text. Below this needs a worker thread.
    expect(nextForwardBatch(1, 30_000, 250, 32)).toBe(1);
    expect(nextForwardBatch(4, 120_000, 250, 32)).toBe(1);
  });

  it("never goes above the cap, however cheap the model looks", () => {
    expect(nextForwardBatch(8, 1, 250, 32)).toBe(32);
    expect(nextForwardBatch(8, 0, 250, 32)).toBe(16); // unmeasurable: step up, don't jump
    expect(nextForwardBatch(32, 0, 250, 32)).toBe(32);
  });

  it("a nonsense pass asks for one rather than dividing by zero", () => {
    expect(nextForwardBatch(0, 100, 250, 32)).toBe(1);
  });
});
