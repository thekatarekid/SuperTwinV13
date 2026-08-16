// ===========================================================================
// Enrichment batching, routing and priority (arch §10.1, §9.2/§9.3, item 1.4).
//
// Four properties are under test here and nothing else is:
//   * the §10.1 executor map — vision is [LLM-S], transcription is [ML],
//     scraping is [CODE], and no row routes to two of them;
//   * the id echo as a SET, in both directions;
//   * binary degradation — 16 → 8 + 8, never 16 solo reads, and never a partial
//     application of a rejected answer;
//   * the queue key — tier, then horizon, then recency. Never insertion order.
//
// No model, no ffmpeg, no network: everything below is [CODE].
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  DEFAULT_IMAGE_BATCH_SIZE,
  MAX_IMAGE_BATCH_SIZE,
  batchable,
  clampImageBatchSize,
  enrichmentPriority,
  enrichmentRoute,
  getEnrichmentImageBatchSize,
  getEnrichmentReadAllMedia,
  getEnrichmentSalienceGate,
  orderByEnrichmentPriority,
  planBatches,
  runBatchWithSplit,
  setEnrichmentImageBatchSize,
  setEnrichmentReadAllMedia,
  splitInHalf,
  verifyEcho,
  visionCopyPath,
  visionTarget,
  VISION_MAX_EDGE,
} from "./batch.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-batch-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("enrichment settings (§8.4 table, §10.1)", () => {
  it("batches 16 images by default, and clamps to 1–32", () => {
    expect(DEFAULT_IMAGE_BATCH_SIZE).toBe(16);
    expect(getEnrichmentImageBatchSize()).toBe(16);

    setEnrichmentImageBatchSize(32);
    expect(getEnrichmentImageBatchSize()).toBe(32);
    setEnrichmentImageBatchSize(500);
    expect(getEnrichmentImageBatchSize()).toBe(MAX_IMAGE_BATCH_SIZE);
    setEnrichmentImageBatchSize(0);
    expect(getEnrichmentImageBatchSize()).toBe(1);
    expect(clampImageBatchSize(Number.NaN)).toBe(16);
  });

  it("reads all media by default and gates salience by nothing", () => {
    expect(getEnrichmentReadAllMedia()).toBe(true);
    expect(getEnrichmentSalienceGate()).toBe(false);
  });
});

describe("the executor map (§10.1)", () => {
  it("routes vision to [LLM-S] and never to [ML]", () => {
    for (const kind of ["image", "sticker"]) {
      expect(enrichmentRoute({ kind })).toMatchObject({
        step: "caption",
        executor: "[LLM-S]",
        batched: true,
      });
    }
  });

  it("routes a voice note to on-device [ML], with no model in the loop", () => {
    for (const kind of ["audio", "voice", "ptt"]) {
      expect(enrichmentRoute({ kind, seconds: 45 })).toMatchObject({
        step: "transcription",
        executor: "[ML]",
        engine: "whisper.cpp",
      });
    }
  });

  it("reads a video as ONE call over its frames, never one per frame", () => {
    expect(enrichmentRoute({ kind: "video", seconds: 180 })).toMatchObject({
      step: "caption",
      executor: "[LLM-S]",
      batched: false,
    });
  });

  it("scrapes links in [CODE], with yt-dlp only for YouTube", () => {
    expect(enrichmentRoute({ kind: "link", url: "https://booking.com/x" })).toMatchObject({
      executor: "[CODE]",
      engine: "fetch",
    });
    expect(enrichmentRoute({ kind: "link", url: "https://youtu.be/abc" })).toMatchObject({
      executor: "[CODE]",
      engine: "yt-dlp",
    });
    expect(enrichmentRoute({ kind: "link", url: "https://amazon.in/dp/1" }).executor).toBe("[CODE]");
  });

  it("stickers are captioned by default, and skipped only when read_all_media is off", () => {
    expect(enrichmentRoute({ kind: "sticker" }).step).toBe("caption");
    setEnrichmentReadAllMedia(false);
    expect(enrichmentRoute({ kind: "sticker" }).step).toBe("skip");
    // A photo is still read: the switch is about stickers and short audio only.
    expect(enrichmentRoute({ kind: "image" }).step).toBe("caption");
    expect(enrichmentRoute({ kind: "audio", seconds: 1 }).step).toBe("skip");
    expect(enrichmentRoute({ kind: "audio", seconds: 10 }).step).toBe("transcription");
  });

  it("only images and stickers ride a shared call", () => {
    expect(batchable({ kind: "image" })).toBe(true);
    expect(batchable({ kind: "sticker" })).toBe(true);
    expect(batchable({ kind: "video" })).toBe(false);
    expect(batchable({ kind: "document" })).toBe(false);
  });
});

describe("downscale before send (§10.1 point 2)", () => {
  it("fits the longest edge to 1092 px, preserving aspect", () => {
    expect(visionTarget(3000, 2000)).toEqual({ width: 1092, height: 728, scaled: true });
    expect(visionTarget(2000, 3000)).toEqual({ width: 728, height: 1092, scaled: true });
    const phone = visionTarget(4032, 3024);
    expect(Math.max(phone.width, phone.height)).toBe(VISION_MAX_EDGE);
  });

  it("leaves an image already inside the cap alone", () => {
    expect(visionTarget(800, 600)).toEqual({ width: 800, height: 600, scaled: false });
    expect(visionTarget(1092, 1092).scaled).toBe(false);
  });

  it("names the downscaled copy beside the original", () => {
    expect(visionCopyPath("/m/alice/IMG_1.jpg")).toBe("/m/alice/IMG_1.v1092.jpg");
  });
});

describe("the id echo (§10.1 point 3)", () => {
  it("matches only when the two sets are equal", () => {
    expect(verifyEcho(["#01", "#02"], ["#02", "#01"]).matched).toBe(true);
    expect(verifyEcho(["#01", "#02"], ["#01"])).toMatchObject({
      matched: false,
      missing: ["#02"],
    });
    expect(verifyEcho(["#01"], ["#01", "#09"])).toMatchObject({
      matched: false,
      unexpected: ["#09"],
    });
    expect(verifyEcho(["#01", "#02"], ["#01", "#01"])).toMatchObject({
      matched: false,
      missing: ["#02"],
      unexpected: ["#01"],
    });
  });

  it("splits a rejected batch in half, left never smaller than right", () => {
    expect(splitInHalf([1, 2, 3, 4])).toEqual([[1, 2], [3, 4]]);
    expect(splitInHalf([1, 2, 3])).toEqual([[1, 2], [3]]);
  });

  it("plans whole batches at the configured size", () => {
    expect(planBatches(Array.from({ length: 17 }, (_, i) => i), 16).map((b) => b.length)).toEqual([
      16, 1,
    ]);
  });
});

interface Row {
  id: string;
}

const rows = (n: number, from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `r${from + i}` }));

describe("binary degradation (§10.1 point 4)", () => {
  it("a clean 16 is one call", async () => {
    const calls: number[] = [];
    const applied: string[] = [];
    const outcome = await runBatchWithSplit(rows(16), {
      call: async (chunk) => {
        calls.push(chunk.length);
        return { results: new Map(chunk.map((r) => [r.id, `saw ${r.id}`])) };
      },
      apply: (row) => applied.push(row.id),
      solo: async () => {
        throw new Error("no solo read should happen");
      },
    });
    expect(calls).toEqual([16]);
    expect(applied).toHaveLength(16);
    expect(outcome).toMatchObject({ calls: 1, mismatches: 0, solo: 0 });
  });

  it("16 one caption short costs THREE calls, not sixteen", async () => {
    const calls: number[] = [];
    const outcome = await runBatchWithSplit(rows(16), {
      call: async (chunk) => {
        calls.push(chunk.length);
        const results = new Map(chunk.map((r) => [r.id, `saw ${r.id}`]));
        if (chunk.length === 16) results.delete("r9");
        return { results };
      },
      apply: () => undefined,
      solo: async () => {
        throw new Error("no solo read should happen");
      },
    });
    expect(calls).toEqual([16, 8, 8]);
    expect(outcome).toMatchObject({ calls: 3, mismatches: 1, solo: 0 });
  });

  it("never applies a rejected answer in part", async () => {
    const applied: string[] = [];
    await runBatchWithSplit(rows(2), {
      call: async (chunk) => {
        const results = new Map(chunk.map((r) => [r.id, "x"]));
        results.delete("r1");
        return { results };
      },
      apply: (row) => applied.push(row.id),
      solo: async (row) => {
        applied.push(`solo:${row.id}`);
      },
    });
    // r0's block did line up — and is still thrown away with the rest.
    expect(applied).toEqual(["solo:r0", "solo:r1"]);
  });

  it("bottoms out at a single read rather than looping", async () => {
    const outcome = await runBatchWithSplit(rows(4), {
      call: async () => ({ results: new Map() }),
      apply: () => undefined,
      solo: async () => undefined,
    });
    expect(outcome).toMatchObject({ calls: 3, mismatches: 3, solo: 4 });
  });

  it("a refusal stops the recursion instead of knocking again", async () => {
    let calls = 0;
    const outcome = await runBatchWithSplit(rows(8), {
      call: async () => {
        calls += 1;
        return { results: new Map(), refused: true };
      },
      apply: () => undefined,
      solo: async () => {
        throw new Error("a refused batch must not become solo reads");
      },
    });
    expect(calls).toBe(1);
    expect(outcome.refused).toBe(true);
  });
});

describe("the queue key (§9.2, §9.3)", () => {
  const NOW = Date.parse("2026-08-15T12:00:00.000Z");
  const ago = (ms: number): string => new Date(NOW - ms).toISOString();

  it("a photo from an hour ago is read before a photo from 2023", () => {
    const recent = { id: "recent", ts: ago(3_600_000), tier: "T1" };
    const old = { id: "old", ts: "2023-05-01T09:00:00.000Z", tier: "T1" };
    expect(enrichmentPriority(recent, NOW)).toBeGreaterThan(enrichmentPriority(old, NOW));
    // ...and in the order the queue actually takes them, whichever way they
    // were inserted. FIFO would hand back [old, recent].
    expect(orderByEnrichmentPriority([old, recent], NOW).map((u) => u.id)).toEqual([
      "recent",
      "old",
    ]);
  });

  it("tier outranks recency: a T4 blast from an hour ago waits behind a T1 photo from last week", () => {
    const blast = { id: "blast", ts: ago(3_600_000), tier: "T4" };
    const friend = { id: "friend", ts: ago(6 * 86_400_000), tier: "T1" };
    expect(orderByEnrichmentPriority([blast, friend], NOW).map((u) => u.id)).toEqual([
      "friend",
      "blast",
    ]);
  });

  it("orders a burst finer than the ten-minute recency grain", () => {
    const burst = [3, 1, 2].map((i) => ({ id: `p${i}`, ts: ago(i * 1_000), tier: "T1" }));
    expect(orderByEnrichmentPriority(burst, NOW).map((u) => u.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("an untiered stream still sorts — it never falls out of the queue", () => {
    const untiered = { id: "u", ts: ago(1_000), tier: null };
    expect(enrichmentPriority(untiered, NOW)).toBeGreaterThan(0);
  });
});
