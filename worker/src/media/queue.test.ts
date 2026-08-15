// ===========================================================================
// Media queue tests (vitest): the throttle, the live fast path, every switch,
// image batching (and what happens when a batch answer cannot be mapped back),
// link scraping, concurrency and its backoff, and what a failure or a shutdown
// mid-read leaves behind.
//
// A real temp DB (the queue's only state lives in events.media_desc_* and
// events.link_scrape_*) plus a stubbed reader and a stubbed fetch, so neither
// `claude` nor the network is ever touched. Timers are faked — the whole point
// of the loop is when it does things.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  claimPendingMedia,
  insertEvent,
  recordMediaFrames,
  recordVideoPoster,
  upsertChannel,
  upsertSource,
  type InsertEventRow,
  type PendingMediaRow,
} from "../db/ingest.js";
import {
  DEFAULT_MEDIA_CONCURRENCY,
  setMediaBackfillEnabled,
  setMediaConcurrency,
  setMediaDescribeEnabled,
  setMediaRatePerMin,
  setMediaVideoAudioEnabled,
  setMediaVideoFrameIntervalSec,
  setMediaVideoFramesEnabled,
  setMediaVoiceNotesEnabled,
} from "../store/store.js";
import type { DescribeBatchResult, DescribeResult } from "./describe.js";
import type { SampleResult } from "./frames.js";
import type { LinkScrapeResult, ScrapeOptions } from "./link.js";
import type { TranscribeResult } from "./transcribe.js";
import {
  enqueueLiveMedia,
  isRefusal,
  MediaQueue,
  startMediaQueue,
  stopMediaQueue,
  type MediaQueueOptions,
} from "./queue.js";
import {
  setMediaBusinessEnabled,
  setMediaImageBatch,
  setMediaImagesEnabled,
  setMediaLinkScrapeEnabled,
  setMediaVideoEnabled,
} from "./switches.js";

let tmpDir: string;
let queue: MediaQueue | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-queue-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  // The idle loop sweeps unreferenced frame files off disk, so the media root
  // has to be this temp dir and not the developer's real one.
  process.env.SUPERTWIN_MEDIA_DIR = join(tmpDir, "media");
  mkdirSync(join(tmpDir, "media"), { recursive: true });
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  vi.useFakeTimers();
  // One read per second, so a throttle tick is easy to step over.
  setMediaRatePerMin(60);
});

afterEach(() => {
  queue?.stop();
  queue = null;
  stopMediaQueue();
  vi.useRealTimers();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_MEDIA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Everything claimable by default. `ts` decides the newest-first order. */
const ALL_KINDS = {
  images: true,
  video: true,
  documents: true,
  business: true,
} as const;

/** A pending image event, unless `over` says otherwise. */
function seed(
  externalId: string,
  ts: string,
  over: Partial<InsertEventRow> = {},
): string {
  return insertEvent({
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId: null,
    actorId: null,
    ts,
    kind: "image",
    text: "",
    mediaPath: `/media/${externalId}.jpg`,
    rawJson: null,
    mediaMime: "image/jpeg",
    ...over,
  }).id;
}

/** `n` pending images, one second apart, newest (i0) first in a ts DESC claim. */
function seedImages(n: number, from = "2026-07-02T10:00:00.000Z"): string[] {
  const start = Date.parse(from);
  return Array.from({ length: n }, (_, i) =>
    seed(`i${i}`, new Date(start - i * 1_000).toISOString()),
  );
}

/** A pending document, which is never batchable. */
function seedDoc(externalId: string, ts: string): string {
  return seed(externalId, ts, {
    kind: "document",
    mediaPath: `/media/${externalId}.pdf`,
    mediaMime: "application/pdf",
    mediaFilename: `${externalId}.pdf`,
  });
}

/** A pending link event. */
function seedLink(externalId: string, ts: string, url: string): string {
  return insertEvent({
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    channelId: null,
    actorId: null,
    ts,
    kind: "message",
    text: `look: ${url}`,
    mediaPath: null,
    rawJson: null,
    linkUrl: url,
  }).id;
}

interface StoredDesc {
  media_description: string | null;
  media_desc_status: string | null;
  media_desc_error: string | null;
  media_desc_model: string | null;
}

function stored(id: string): StoredDesc {
  return getDb()
    .prepare(
      `SELECT media_description, media_desc_status, media_desc_error,
              media_desc_model
         FROM events WHERE id = ?`,
    )
    .get(id) as StoredDesc;
}

interface StoredLink {
  link_title: string | null;
  link_scraped_text: string | null;
  link_scrape_status: string | null;
  link_scrape_error: string | null;
}

function storedLink(id: string): StoredLink {
  return getDb()
    .prepare(
      `SELECT link_title, link_scraped_text, link_scrape_status, link_scrape_error
         FROM events WHERE id = ?`,
    )
    .get(id) as StoredLink;
}

const seen = (row: PendingMediaRow): DescribeResult => ({
  description: `saw ${row.id}`,
  status: "done",
  model: "haiku",
  error: null,
});

/**
 * Reader stub covering both entry points. `groups` records what each CLI call
 * was handed, which is the thing batching changes; `ids` stays the flat order.
 */
function reader(
  outcome: (row: PendingMediaRow) => DescribeResult | Promise<DescribeResult> = seen,
): { ids: string[]; groups: string[][]; opts: MediaQueueOptions } {
  const ids: string[] = [];
  const groups: string[][] = [];
  return {
    ids,
    groups,
    opts: {
      describe: async (row) => {
        ids.push(row.id);
        groups.push([row.id]);
        return outcome(row);
      },
      describeBatch: async (rows): Promise<DescribeBatchResult> => {
        groups.push(rows.map((r) => r.id));
        const results = new Map<string, DescribeResult>();
        for (const row of rows) {
          ids.push(row.id);
          results.set(row.id, await outcome(row));
        }
        return {
          results,
          call: { description: null, status: "done", model: "haiku", error: null },
        };
      },
    },
  };
}

/**
 * The same stub, except every call hangs until it is let go. Overlap is only
 * observable while calls are still open, so this is what the concurrency tests
 * read: `groups.length` is how many are in flight at once.
 */
function gated(): {
  groups: string[][];
  release: () => void;
  opts: MediaQueueOptions;
} {
  const groups: string[][] = [];
  const held: (() => void)[] = [];
  const hold = (): Promise<void> =>
    new Promise<void>((resolve) => held.push(resolve));
  return {
    groups,
    release: () => {
      for (const resolve of held.splice(0)) resolve();
    },
    opts: {
      describe: async (row) => {
        groups.push([row.id]);
        await hold();
        return seen(row);
      },
      describeBatch: async (rows): Promise<DescribeBatchResult> => {
        groups.push(rows.map((r) => r.id));
        await hold();
        return {
          results: new Map(rows.map((r) => [r.id, seen(r)])),
          call: { description: null, status: "done", model: "haiku", error: null },
        };
      },
    },
  };
}

describe("throttle", () => {
  it("drains the backlog one call per tick, waiting for every description it made", async () => {
    seed("a", "2026-07-02T10:00:02.000Z");
    seed("b", "2026-07-02T10:00:01.000Z");
    seed("c", "2026-07-02T10:00:00.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups).toEqual([["wa:a", "wa:b", "wa:c"]]);

    seed("d", "2026-07-02T09:00:01.000Z");
    seed("e", "2026-07-02T09:00:00.000Z");
    // Three descriptions were made, so three ticks are owed before the next call.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(r.groups).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.groups).toEqual([
      ["wa:a", "wa:b", "wa:c"],
      ["wa:d", "wa:e"],
    ]);

    expect(stored("wa:a")).toMatchObject({
      media_description: "saw wa:a",
      media_desc_status: "done",
      media_desc_model: "haiku",
      media_desc_error: null,
    });
  });

  it("a slower rate widens the gap", async () => {
    setMediaRatePerMin(4); // one per 15s
    seed("a", "2026-07-02T10:00:01.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    seed("b", "2026-07-02T10:00:00.000Z");
    await vi.advanceTimersByTimeAsync(14_000);
    expect(r.ids).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.ids).toHaveLength(2);
  });

  it("an idle queue sleeps instead of polling for work", async () => {
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    seed("a", "2026-07-02T10:00:00.000Z");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.ids).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(r.ids).toEqual(["wa:a"]);
  });
});

describe("batching", () => {
  it("a full batch rides one call; the overflow waits for the next", async () => {
    const ids = seedImages(21);
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups[0]).toHaveLength(20);
    // Twenty descriptions were made, so twenty ticks are owed before the next call.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(r.groups).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.groups[1]).toEqual([ids[20]]);
  });

  it("the batch size comes from Settings, and is read at claim time", async () => {
    setMediaImageBatch(3);
    seedImages(7);
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups[0]).toHaveLength(3);

    setMediaImageBatch(4);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(r.groups[1]).toHaveLength(4);
  });

  it("an image the answer never named is read alone, never given another's description", async () => {
    seed("a", "2026-07-02T10:00:02.000Z");
    seed("b", "2026-07-02T10:00:01.000Z");
    seed("c", "2026-07-02T10:00:00.000Z");
    const groups: string[][] = [];
    queue = new MediaQueue({
      describe: async (row) => {
        groups.push([row.id]);
        return { ...seen(row), description: "read alone" };
      },
      // The middle image comes back unmapped: it is simply absent from results.
      describeBatch: async (rows) => {
        groups.push(rows.map((r) => r.id));
        const results = new Map<string, DescribeResult>();
        for (const row of rows) {
          if (row.id !== "wa:b") results.set(row.id, seen(row));
        }
        return {
          results,
          call: { description: null, status: "done", model: "haiku", error: null },
        };
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    // A single leftover goes straight to the read that can settle it, in the
    // same cycle — not to a queue it has to wait in.
    expect(groups).toEqual([["wa:a", "wa:b", "wa:c"], ["wa:b"]]);
    expect(stored("wa:b")).toMatchObject({
      media_desc_status: "done",
      media_description: "read alone",
    });
    // ...and never a description that might belong to a or c.
    expect(stored("wa:a").media_description).toBe("saw wa:a");
  });

  it("an answer that maps nothing is asked again, then read one at a time", async () => {
    seed("a", "2026-07-02T10:00:02.000Z");
    seed("b", "2026-07-02T10:00:01.000Z");
    seed("c", "2026-07-02T10:00:00.000Z");
    const groups: string[][] = [];
    queue = new MediaQueue({
      // Every solo read fails retryably, so the rows are still pending next
      // cycle — which is how "not quarantined" is visible at all.
      describe: async (row) => {
        groups.push([row.id]);
        return {
          description: null,
          status: "error",
          model: "haiku",
          error: "child died",
        };
      },
      describeBatch: async (rows) => {
        groups.push(rows.map((r) => r.id));
        return {
          results: new Map(),
          call: {
            description: null,
            status: "error",
            model: "haiku",
            error: "the answer named none of the 3 files",
          },
        };
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(groups).toEqual([
      ["wa:a", "wa:b", "wa:c"],
      ["wa:a", "wa:b", "wa:c"],
      ["wa:a"],
      ["wa:b"],
      ["wa:c"],
    ]);

    // Nothing was remembered as unbatchable: the next cycle batches them again.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(groups[5]).toEqual(["wa:a", "wa:b", "wa:c"]);
  });

  it("a document is never batched with the images around it", async () => {
    seed("img1", "2026-07-02T10:00:03.000Z");
    seed("doc", "2026-07-02T10:00:02.000Z", {
      kind: "document",
      mediaPath: "/media/doc.pdf",
      mediaMime: "application/pdf",
      mediaFilename: "invoice.pdf",
    });
    seed("img2", "2026-07-02T10:00:01.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups[0]).toEqual(["wa:img1", "wa:img2"]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.groups[1]).toEqual(["wa:doc"]);
  });

  it("a video frame is read one per call", async () => {
    setMediaVideoEnabled(true);
    for (const id of ["v1", "v2"]) {
      seed(id, `2026-07-02T10:00:0${id === "v1" ? 2 : 1}.000Z`, {
        kind: "video",
        mediaPath: `/media/${id}.mp4`,
        mediaMime: "video/mp4",
        mediaThumbPath: `/media/${id}.thumb.jpg`,
      });
    }
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups).toEqual([["wa:v1"]]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.groups).toEqual([["wa:v1"], ["wa:v2"]]);
  });

  it("the newest row being a document does not spend the tick on it", async () => {
    seedDoc("doc", "2026-07-02T10:00:30.000Z");
    const ids = seedImages(20);
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups[0]).toEqual(ids);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(r.groups[1]).toEqual(["wa:doc"]);
  });

  it("a queue of mixed kinds still fills a whole image batch", async () => {
    for (let i = 0; i < 12; i++) {
      seedDoc(`d${i}`, `2026-07-02T10:01:${String(30 - i).padStart(2, "0")}.000Z`);
    }
    const ids = seedImages(20);
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups[0]).toEqual(ids);
  });
});

describe("per-type switches", () => {
  it("images are read by default and held back when switched off", async () => {
    setMediaImagesEnabled(false);
    const id = seed("a", "2026-07-02T10:00:00.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    queue.enqueueLive(id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual([]);
    expect(stored("wa:a").media_desc_status).toBe("pending");

    setMediaImagesEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual(["wa:a"]);
  });

  it("video is off until asked for — a switch flipped on reaches rows already stored", async () => {
    seed("v", "2026-07-02T10:00:00.000Z", {
      kind: "video",
      mediaPath: "/media/v.mp4",
      mediaMime: "video/mp4",
      mediaThumbPath: "/media/v.thumb.jpg",
    });
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual([]);

    setMediaVideoEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual(["wa:v"]);
  });

  it("media in a business chat waits for the business switch", async () => {
    const channelId = upsertChannel({
      sourceId: "whatsapp",
      sourceExtId: "1555@s.whatsapp.net",
      name: "Some Shop",
      kind: "dm",
      isBusiness: true,
    });
    insertEvent({
      externalId: "biz",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      channelId,
      actorId: null,
      ts: "2026-07-02T10:00:00.000Z",
      kind: "image",
      text: "",
      mediaPath: "/media/biz.jpg",
      rawJson: null,
      mediaMime: "image/jpeg",
    });
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual([]);

    setMediaBusinessEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual(["wa:biz"]);
  });
});

describe("link scraping", () => {
  const page: LinkScrapeResult = {
    status: "done",
    scrapedText: "Rates rise again, says the central bank.",
    title: "Rates rise again",
    error: null,
  };

  it("is off by default — no URL is fetched", async () => {
    seedLink("l", "2026-07-02T10:00:00.000Z", "https://example.com/a");
    const urls: string[] = [];
    queue = new MediaQueue({
      scrape: async (url) => {
        urls.push(url);
        return page;
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(urls).toEqual([]);
    expect(storedLink("wa:l").link_scrape_status).toBe("pending");
  });

  it("records the page text and fills a missing title", async () => {
    setMediaLinkScrapeEnabled(true);
    seedLink("l", "2026-07-02T10:00:00.000Z", "https://example.com/a");
    queue = new MediaQueue({ scrape: async () => page });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedLink("wa:l")).toMatchObject({
      link_scrape_status: "done",
      link_scraped_text: "Rates rise again, says the central bank.",
      link_title: "Rates rise again",
      link_scrape_error: null,
    });
  });

  it("has its own gate — no model call is involved, so the reader switch is not one", async () => {
    setMediaDescribeEnabled(false);
    setMediaLinkScrapeEnabled(true);
    seedLink("l", "2026-07-02T10:00:00.000Z", "https://example.com/a");
    queue = new MediaQueue({ scrape: async () => page });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedLink("wa:l").link_scrape_status).toBe("done");
  });

  it("a refusal is terminal and carries its reason; no text is invented", async () => {
    setMediaLinkScrapeEnabled(true);
    seedLink("l", "2026-07-02T10:00:00.000Z", "http://10.0.0.1/admin");
    let calls = 0;
    queue = new MediaQueue({
      scrape: async () => {
        calls += 1;
        return {
          status: "skipped",
          scrapedText: null,
          title: null,
          error: "10.0.0.1 resolves only to non-public addresses",
        };
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    expect(storedLink("wa:l")).toMatchObject({
      link_scrape_status: "skipped",
      link_scraped_text: null,
      link_scrape_error: "10.0.0.1 resolves only to non-public addresses",
    });
  });

  it("a transport failure is retried a bounded number of times", async () => {
    setMediaLinkScrapeEnabled(true);
    seedLink("l", "2026-07-02T10:00:00.000Z", "https://example.com/a");
    let calls = 0;
    queue = new MediaQueue({
      scrape: async () => {
        calls += 1;
        return {
          status: "error",
          scrapedText: null,
          title: null,
          error: "socket hang up",
        };
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedLink("wa:l").link_scrape_status).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(storedLink("wa:l")).toMatchObject({
      link_scrape_status: "error",
      link_scrape_error: "socket hang up",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(3);
  });

  it("waits for the media backlog — a fetch never delays a read", async () => {
    setMediaLinkScrapeEnabled(true);
    seed("a", "2026-07-02T10:00:01.000Z");
    seedLink("l", "2026-07-02T10:00:00.000Z", "https://example.com/a");
    const order: string[] = [];
    const r = reader((row) => {
      order.push(`read ${row.id}`);
      return seen(row);
    });
    queue = new MediaQueue({
      ...r.opts,
      scrape: async (url) => {
        order.push(`fetch ${url}`);
        return page;
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["read wa:a"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["read wa:a", "fetch https://example.com/a"]);
  });

  it("hands the fetch the video controls the settings say it may use", async () => {
    setMediaLinkScrapeEnabled(true);
    setMediaVideoFramesEnabled(true);
    setMediaVideoFrameIntervalSec(30);
    const id = seedLink("l", "2026-07-02T10:00:00.000Z", "https://youtu.be/aircAruvnKk");
    let given: ScrapeOptions | null = null;
    queue = new MediaQueue({
      scrape: async (_url, opts) => {
        given = opts;
        return page;
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    // v7 §4 mirrors the existing video-frame controls rather than adding a
    // second set, and the row id is what its stills are named after.
    expect(given!.video).toEqual({
      eventId: id,
      frames: true,
      intervalSec: 30,
      maxFrames: 8,
      audio: true,
      maxHeight: 480,
    });
  });

  it("records the stills a linked video gave up, even when the read then failed", async () => {
    setMediaLinkScrapeEnabled(true);
    const frames = [{ path: join(tmpDir, "media", "abc.frame0.jpg"), seconds: 1.5 }];
    const id = seedLink("l", "2026-07-02T10:00:00.000Z", "https://youtu.be/aircAruvnKk");
    queue = new MediaQueue({
      scrape: async () => ({
        status: "error",
        scrapedText: null,
        title: null,
        error: "HTTP 503",
        frames,
      }),
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    // The column is the only record those files exist; without it the next
    // idle sweep deletes stills we are about to retry into.
    expect(JSON.parse(storedFrames(id)!)).toEqual(frames);
  });
});

describe("pause", () => {
  it("describe_enabled off stops the reader entirely", async () => {
    setMediaDescribeEnabled(false);
    const id = seed("a", "2026-07-02T10:00:00.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    queue.enqueueLive(id);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.ids).toEqual([]);
    expect(stored("wa:a").media_desc_status).toBe("pending");

    setMediaDescribeEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual(["wa:a"]);
  });

  it("backfill_enabled off leaves the backlog alone but still reads live media", async () => {
    setMediaBackfillEnabled(false);
    seed("old", "2026-07-02T10:00:00.000Z");
    const liveId = seed("live", "2026-07-02T10:00:01.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    queue.enqueueLive(liveId);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.ids).toEqual(["wa:live"]);
    expect(stored("wa:old").media_desc_status).toBe("pending");
  });
});

describe("live media", () => {
  it("jumps ahead of an older backlog and is not throttled", async () => {
    seed("old1", "2026-07-02T10:00:02.000Z");
    seed("old2", "2026-07-02T10:00:01.000Z");
    const liveId = seed("live", "2026-07-02T09:00:00.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    queue.enqueueLive(liveId);

    await vi.advanceTimersByTimeAsync(0);
    // Read alone, in its own call, despite being the oldest row — the backlog
    // does not ride along on a call that exists to be fast. Both go at once:
    // the live read pays no throttle, so the slot the backlog wants is free.
    expect(r.groups).toHaveLength(2);
    expect(r.groups).toEqual(
      expect.arrayContaining([["wa:live"], ["wa:old1", "wa:old2"]]),
    );
  });

  it("takes the next free slot ahead of the backlog when there is only one", async () => {
    setMediaConcurrency(1);
    seedDoc("d1", "2026-07-02T10:00:02.000Z");
    seedDoc("d2", "2026-07-02T10:00:01.000Z");
    // A document, so the claim's batchable-first ordering is not what decides.
    const liveId = seedDoc("live", "2026-07-02T09:00:00.000Z");
    const g = gated();
    queue = new MediaQueue(g.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(g.groups).toEqual([["wa:d1"]]);

    // The only slot is busy, and a model call in flight is not interrupted.
    queue.enqueueLive(liveId);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toEqual([["wa:d1"]]);

    // The moment it frees, live goes first — ahead of the older document.
    g.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toEqual([["wa:d1"], ["wa:live"]]);
  });

  it("wakes an idle queue immediately", async () => {
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    const id = seed("live", "2026-07-02T10:00:00.000Z");
    queue.enqueueLive(id);
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ids).toEqual(["wa:live"]);
  });

  it("a history replay is backlog: it batches, and it waits its turn", async () => {
    const ids = seedImages(21);
    const r = reader();
    startMediaQueue(r.opts);
    for (const id of ids) enqueueLiveMedia(id, true);

    await vi.advanceTimersByTimeAsync(0);
    // One call for the batch, not one per arrival...
    expect(r.groups).toEqual([ids.slice(0, 20)]);
    // ...and the throttle still applies, which is exactly what "live" bypasses.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(r.groups).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.groups[1]).toEqual([ids[20]]);
  });

  it("a history replay does not read while the backlog is switched off", async () => {
    setMediaBackfillEnabled(false);
    const id = seed("h", "2026-07-02T10:00:00.000Z");
    const r = reader();
    startMediaQueue(r.opts);
    enqueueLiveMedia(id, true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual([]);
    expect(stored("wa:h").media_desc_status).toBe("pending");
  });

  it("a row stamped historical stays backlog even if something calls it live", async () => {
    setMediaBackfillEnabled(false);
    const id = seed("h", "2026-07-02T10:00:00.000Z", { isHistorical: true });
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    queue.enqueueLive(id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v6 §5 — several calls at once, and what stops them all at once.
// ---------------------------------------------------------------------------

/** `n` pending documents, one second apart. Documents never share a call. */
function seedDocs(n: number, from = "2026-07-02T10:00:00.000Z"): string[] {
  const start = Date.parse(from);
  return Array.from({ length: n }, (_, i) =>
    seedDoc(`d${i}`, new Date(start - i * 1_000).toISOString()),
  );
}

describe("concurrency", () => {
  it("keeps five calls open at once by default, and never a sixth", async () => {
    seedDocs(8);
    const g = gated();
    queue = new MediaQueue(g.opts);
    queue.start();

    // One description owed per document, so the starts are a throttle tick
    // apart — five of them fit long before the cap gives way.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toHaveLength(DEFAULT_MEDIA_CONCURRENCY);
    // And they really are open at the same time: not one has answered yet.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(g.groups).toHaveLength(DEFAULT_MEDIA_CONCURRENCY);

    g.release();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toHaveLength(8);
  });

  it("the cap comes from Settings, and a raised one is taken up", async () => {
    setMediaConcurrency(2);
    seedDocs(5);
    const g = gated();
    queue = new MediaQueue(g.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(g.groups).toHaveLength(2);

    setMediaConcurrency(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(g.groups).toHaveLength(4);
  });

  it("a batch and a single read each cost one slot, not one per file", async () => {
    setMediaImageBatch(2);
    setMediaConcurrency(2);
    const ids = seedImages(6);
    const g = gated();
    queue = new MediaQueue(g.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toEqual([ids.slice(0, 2), ids.slice(2, 4)]);
    // Four files are in flight across two slots; the cap counts CALLS.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(g.groups).toHaveLength(2);
  });

  it("leaves every in-flight row plainly pending, so a crash loses nothing", async () => {
    setMediaConcurrency(3);
    const ids = seedDocs(3);
    const g = gated();
    queue = new MediaQueue(g.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toHaveLength(3);
    // Nothing in the DB marks them as anyone's work, so a kill right here is a
    // queue that simply starts again — no row is stuck in flight.
    expect(claimPendingMedia(10, ALL_KINDS).map((p) => p.id)).toEqual(ids);
  });

  it("a shutdown with every slot busy records nothing", async () => {
    setMediaConcurrency(3);
    const ids = seedDocs(3);
    const g = gated();
    queue = new MediaQueue(g.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(g.groups).toHaveLength(3);

    queue.stop();
    g.release();
    await vi.advanceTimersByTimeAsync(10_000);
    for (const id of ids) {
      expect(stored(id)).toMatchObject({
        media_desc_status: "pending",
        media_desc_error: null,
        media_description: null,
      });
    }
  });
});

describe("rate limits", () => {
  /** What the five-hour subscription limit comes back as. */
  const refused: DescribeResult = {
    description: null,
    status: "error",
    model: "haiku",
    error: "Claude AI usage limit reached (overageStatus: rejected)",
  };

  it("tells the API's refusals apart from an ordinary failure", () => {
    for (const message of [
      refused.error!,
      "API Error: 429 rate_limit_error",
      "API Error: 401 authentication_error",
      "Your credit balance is too low",
      "Please run /login",
    ]) {
      expect(isRefusal(message)).toBe(true);
    }
    for (const message of [
      "child died",
      "read timed out",
      "file not found: /media/4290.jpg",
      "the model returned no description",
    ]) {
      expect(isRefusal(message)).toBe(false);
    }
    expect(isRefusal(null)).toBe(false);
  });

  it("one refusal closes the door for every slot, on a doubling wait", async () => {
    seedDocs(6);
    const r = reader(() => refused);
    queue = new MediaQueue({ ...r.opts, log: () => {} });
    queue.start();

    // Five slots would otherwise have spent five more calls within four seconds.
    await vi.advanceTimersByTimeAsync(59_999);
    expect(r.groups).toEqual([["wa:d0"]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.groups).toHaveLength(2);

    // ...and the wait doubles rather than settling into a minute-long poll.
    await vi.advanceTimersByTimeAsync(119_999);
    expect(r.groups).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.groups).toHaveLength(3);
  });

  it("costs the row none of its three attempts", async () => {
    seedDocs(1);
    const r = reader(() => refused);
    queue = new MediaQueue({ ...r.opts, log: () => {} });
    queue.start();

    await vi.advanceTimersByTimeAsync(500_000);
    // Four calls in — one more than a row's attempts — and it is still queued
    // rather than written off, because none of them was about the file.
    expect(r.ids).toHaveLength(4);
    expect(stored("wa:d0")).toMatchObject({
      media_desc_status: "pending",
      media_desc_error: refused.error,
    });
  });

  it("a batch is not re-read one file at a time into the same limit", async () => {
    const ids = seedImages(3);
    const groups: string[][] = [];
    queue = new MediaQueue({
      describe: async (row) => {
        groups.push([row.id]);
        return refused;
      },
      describeBatch: async (rows) => {
        groups.push(rows.map((r) => r.id));
        return {
          results: new Map(rows.map((r) => [r.id, refused])),
          call: refused,
        };
      },
      log: () => {},
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(groups).toEqual([ids]);
    for (const id of ids) {
      expect(stored(id).media_desc_status).toBe("pending");
    }
  });

  it("a call that gets through clears the wait", async () => {
    seedDocs(2);
    let calls = 0;
    const r = reader((row) => {
      calls += 1;
      return calls === 1 || calls === 3 ? refused : seen(row);
    });
    queue = new MediaQueue({ ...r.opts, log: () => {} });
    queue.start();

    // Refused at 0, read at 60s, refused again at 61s — and that third call
    // waits a minute, not the two the first refusal had escalated to.
    await vi.advanceTimersByTimeAsync(120_999);
    expect(r.ids).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.ids).toHaveLength(4);
  });

  it("keeps transcribing — whisper costs nothing the limit is counting", async () => {
    seedDoc("d", "2026-07-02T10:00:01.000Z");
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const order: string[] = [];
    queue = new MediaQueue({
      describe: async (row) => {
        order.push(`read ${row.id}`);
        return refused;
      },
      transcribe: async (row) => {
        order.push(`hear ${row.id}`);
        return {
          transcript: "Haan bhai.",
          status: "done",
          model: "large-v3-turbo-q5_0",
          error: null,
        };
      },
      log: () => {},
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(order).toEqual(["read wa:d", "hear wa:a"]);
  });
});

describe("failures", () => {
  it("a crash mid-read leaves the row pending, with the reason on it", async () => {
    seed("a", "2026-07-02T10:00:00.000Z");
    const r = reader(() => {
      throw new Error("child died");
    });
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stored("wa:a")).toMatchObject({
      media_desc_status: "pending",
      media_desc_error: "child died",
      media_description: null,
    });
    expect(claimPendingMedia(10, ALL_KINDS).map((p) => p.id)).toEqual(["wa:a"]);
  });

  it("retries are bounded — the third failure is recorded as terminal", async () => {
    seed("a", "2026-07-02T10:00:00.000Z");
    const r = reader(() => ({
      description: null,
      status: "error",
      model: "haiku",
      error: "read timed out",
    }));
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored("wa:a").media_desc_status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stored("wa:a")).toMatchObject({
      media_desc_status: "error",
      media_desc_error: "read timed out",
    });

    // Off the queue for good: a fourth cycle finds nothing to do.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toHaveLength(3);
  });

  it("logs one run per call, with the prompt size and the cache halves of the spend", async () => {
    seed("a", "2026-07-02T10:00:02.000Z");
    seed("b", "2026-07-02T10:00:01.000Z");
    seed("doc", "2026-07-02T10:00:00.000Z", {
      kind: "document",
      mediaPath: "/media/doc.pdf",
      mediaMime: "application/pdf",
      mediaFilename: "scan.pdf",
    });
    queue = new MediaQueue({
      describe: async (row) => ({
        description: null,
        status: "unsupported",
        model: "haiku",
        error: `nothing to read for ${row.id}`,
      }),
      describeBatch: async (rows) => ({
        results: new Map(rows.map((r) => [r.id, seen(r)])),
        call: {
          description: null,
          status: "done",
          model: "haiku",
          error: null,
          promptChars: 812,
          usage: {
            inputTokens: 17,
            cacheCreationInputTokens: 10_472,
            cacheReadInputTokens: 48_000,
            outputTokens: 206,
            costUsd: 0.014,
          },
        },
      }),
    });
    queue.start();
    await vi.advanceTimersByTimeAsync(3_000);

    // The document came back unsupported — no call was made for it, so no run.
    expect(
      getDb()
        .prepare(
          `SELECT run_id, kind, status, prompt_chars, input_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens,
                  output_tokens, cost_usd
             FROM extraction_runs`,
        )
        .all(),
    ).toEqual([
      {
        run_id: "media-batch-wa:a",
        kind: "media",
        status: "ok",
        prompt_chars: 812,
        input_tokens: 17,
        cache_creation_input_tokens: 10_472,
        cache_read_input_tokens: 48_000,
        output_tokens: 206,
        cost_usd: 0.014,
      },
    ]);
  });

  it("an unsupported verdict is recorded without inventing a description", async () => {
    seed("a", "2026-07-02T10:00:00.000Z");
    const r = reader(() => ({
      description: null,
      status: "unsupported",
      model: "haiku",
      error: "audio is never transcribed",
    }));
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(stored("wa:a")).toMatchObject({
      media_desc_status: "unsupported",
      media_description: null,
    });
  });

  it("a reader that throws does not stop the loop", async () => {
    seed("a", "2026-07-02T10:00:01.000Z");
    seed("b", "2026-07-02T10:00:00.000Z");
    let first = true;
    const r = reader(() => {
      if (first) {
        first = false;
        throw new Error("child died");
      }
      return { description: "ok", status: "done", model: "haiku", error: null };
    });
    queue = new MediaQueue(r.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(r.groups.length).toBeGreaterThan(1);
  });
});

describe("lifecycle", () => {
  it("starting twice does not double the work rate", async () => {
    seed("a", "2026-07-02T10:00:01.000Z");
    seed("b", "2026-07-02T10:00:00.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    queue.start();
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups).toEqual([["wa:a", "wa:b"]]);
  });

  it("stopping mid-read records no verdict — the row is simply still pending", async () => {
    seed("a", "2026-07-02T10:00:00.000Z");
    let release: (() => void) | null = null;
    const r = reader(
      () =>
        new Promise<DescribeResult>((resolve) => {
          release = () =>
            resolve({
              description: "too late",
              status: "done",
              model: "haiku",
              error: null,
            });
        }),
    );
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.ids).toEqual(["wa:a"]);

    queue.stop();
    release!();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(stored("wa:a")).toMatchObject({
      media_desc_status: "pending",
      media_desc_error: null,
      media_description: null,
    });
    expect(r.ids).toEqual(["wa:a"]);
  });

  it("a stopped queue drops live ids instead of queueing them for nobody", async () => {
    const r = reader();
    const id = seed("a", "2026-07-02T10:00:00.000Z");

    enqueueLiveMedia(id); // no queue running yet — must not throw
    const started = startMediaQueue(r.opts);
    expect(startMediaQueue(r.opts)).toBe(started);

    stopMediaQueue();
    enqueueLiveMedia(id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.ids).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// v5 §2 / §3 — video frames and transcription.
// ---------------------------------------------------------------------------

/** A pending video, with a thumbnail so the pre-v5 path also has something. */
function seedVideo(externalId: string, ts: string): string {
  return seed(externalId, ts, {
    kind: "video",
    mediaPath: join(tmpDir, "media", `${externalId}.mp4`),
    mediaMime: "video/mp4",
    mediaThumbPath: join(tmpDir, "media", `${externalId}.thumb.jpg`),
    mediaSeconds: 20,
  });
}

/** A pending voice note. */
function seedAudio(externalId: string, ts: string): string {
  return seed(externalId, ts, {
    kind: "audio",
    mediaPath: join(tmpDir, "media", `${externalId}.ogg`),
    mediaMime: "audio/ogg; codecs=opus",
    mediaSeconds: 12,
    mediaMetaJson: JSON.stringify({ voice: true }),
  });
}

interface StoredTranscript {
  transcript: string | null;
  transcript_status: string | null;
  transcript_model: string | null;
  transcript_error: string | null;
}

function storedTranscript(id: string): StoredTranscript {
  return getDb()
    .prepare(
      `SELECT transcript, transcript_status, transcript_model, transcript_error
         FROM events WHERE id = ?`,
    )
    .get(id) as StoredTranscript;
}

function storedFrames(id: string): string | null {
  return (
    getDb()
      .prepare(`SELECT media_frames_json AS j FROM events WHERE id = ?`)
      .get(id) as { j: string | null }
  ).j;
}

/** A sampler that reports N frames per video and records what it was asked. */
function sampler(count = 3): {
  asked: { id: string; intervalSec: number; maxFrames: number }[];
  sampleFrames: NonNullable<MediaQueueOptions["sampleFrames"]>;
} {
  const asked: { id: string; intervalSec: number; maxFrames: number }[] = [];
  return {
    asked,
    sampleFrames: async (row, opts): Promise<SampleResult> => {
      asked.push({
        id: row.id,
        intervalSec: opts.intervalSec,
        maxFrames: opts.maxFrames,
      });
      return {
        frames: Array.from({ length: count }, (_, i) => ({
          path: `${row.mediaPath}.frame${i}.jpg`,
          seconds: 2.5 + i * 5,
        })),
        error: null,
      };
    },
  };
}

describe("video frames", () => {
  it("with the switch off nothing is sampled and the reader sees no frames", async () => {
    setMediaVideoEnabled(true);
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    const s = sampler();
    const seenFrames: unknown[] = [];
    queue = new MediaQueue({
      sampleFrames: s.sampleFrames,
      describe: async (row, opts) => {
        seenFrames.push(opts.frames);
        return seen(row);
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(s.asked).toEqual([]);
    expect(seenFrames).toEqual([[]]);
    expect(storedFrames("wa:v")).toBeNull();
  });

  it("samples across the clip and hands every frame to ONE read", async () => {
    setMediaVideoEnabled(true);
    setMediaVideoFramesEnabled(true);
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    const s = sampler(4);
    let handed: unknown = null;
    let calls = 0;
    queue = new MediaQueue({
      sampleFrames: s.sampleFrames,
      describe: async (row, opts) => {
        calls += 1;
        handed = opts.frames;
        return seen(row);
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(s.asked).toEqual([{ id: "wa:v", intervalSec: 5, maxFrames: 8 }]);
    expect(calls).toBe(1);
    expect(handed).toHaveLength(4);
    // The column is the only record those files exist — without it the sweep
    // takes them straight back.
    expect(JSON.parse(storedFrames("wa:v")!)).toHaveLength(4);
    expect(stored("wa:v").media_desc_status).toBe("done");
  });

  it("reads the interval fresh, so a Settings change lands on the next video", async () => {
    setMediaVideoEnabled(true);
    setMediaVideoFramesEnabled(true);
    seedVideo("v1", "2026-07-02T10:00:01.000Z");
    seedVideo("v2", "2026-07-02T10:00:00.000Z");
    const s = sampler();
    queue = new MediaQueue({ ...reader().opts, sampleFrames: s.sampleFrames });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(s.asked[0].intervalSec).toBe(5);

    setMediaVideoFrameIntervalSec(30);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.asked[1].intervalSec).toBe(30);
  });

  it("an image is never sampled — this is a video-only path", async () => {
    setMediaVideoFramesEnabled(true);
    seed("i", "2026-07-02T10:00:00.000Z");
    const s = sampler();
    queue = new MediaQueue({ ...reader().opts, sampleFrames: s.sampleFrames });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(s.asked).toEqual([]);
  });

  it("sampling that fails leaves the read to the thumbnail rather than losing it", async () => {
    setMediaVideoEnabled(true);
    setMediaVideoFramesEnabled(true);
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    let handed: unknown = null;
    queue = new MediaQueue({
      sampleFrames: async () => ({
        frames: [],
        error: "ffmpeg is not installed with the app",
      }),
      describe: async (row, opts) => {
        handed = opts.frames;
        return seen(row);
      },
      log: () => {},
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(handed).toEqual([]);
    expect(storedFrames("wa:v")).toBeNull();
    expect(stored("wa:v").media_desc_status).toBe("done");
  });

  it("a sampler that throws does not stop the read or the loop", async () => {
    setMediaVideoEnabled(true);
    setMediaVideoFramesEnabled(true);
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    const r = reader();
    queue = new MediaQueue({
      ...r.opts,
      sampleFrames: async () => {
        throw new Error("ffmpeg died");
      },
      log: () => {},
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(r.ids).toEqual(["wa:v"]);
    expect(stored("wa:v").media_desc_status).toBe("done");
  });

  it("sweeps frame files the DB no longer points at, and only those", async () => {
    // The sweep is the idle path, and this is the one test whose video file
    // really exists — left transcribable it would be queued work, not idle.
    setMediaVideoAudioEnabled(false);
    const referenced = join(tmpDir, "media", "KEEP.frame0.jpg");
    const orphan = join(tmpDir, "media", "GONE.frame0.jpg");
    const attachment = join(tmpDir, "media", "KEEP.mp4");
    for (const p of [referenced, orphan, attachment]) writeFileSync(p, "x");
    const id = seedVideo("KEEP", "2026-07-02T10:00:00.000Z");
    recordMediaFrames(id, [{ path: referenced, seconds: 2.5 }]);

    queue = new MediaQueue(reader().opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(existsSync(referenced)).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(attachment)).toBe(true);
  });
});

describe("video posters", () => {
  /** A thumbless video: 10 of the 18 in the measured database (v7 §3). */
  function seedPosterless(externalId: string, ts: string): string {
    return seed(externalId, ts, {
      kind: "video",
      mediaPath: join(tmpDir, "media", `${externalId}.mp4`),
      mediaMime: "video/mp4",
      mediaSeconds: 162,
    });
  }

  function storedThumb(id: string): string | null {
    return (
      getDb()
        .prepare(`SELECT media_thumb_path AS p FROM events WHERE id = ?`)
        .get(id) as { p: string | null }
    ).p;
  }

  /** A poster maker that records what it was asked and writes the path. */
  function poster(succeeds = true): {
    asked: string[];
    opts: MediaQueueOptions;
  } {
    const asked: string[] = [];
    return {
      asked,
      opts: {
        poster: async (row) => {
          asked.push(row.id);
          if (!succeeds) return { path: null, error: "could not seek" };
          const path = `${row.mediaPath}.poster.jpg`;
          recordVideoPoster(row.id, path);
          return { path, error: null };
        },
      },
    };
  }

  it("gives a video with no thumbnail one, and that is what unlocks the read", async () => {
    setMediaVideoEnabled(true);
    const id = seedPosterless("v", "2026-07-02T10:00:00.000Z");
    // Until there is a poster the row is pending but unreadable: there is
    // nothing on it for the reader to open (v7 §3).
    expect(claimPendingMedia(10, ALL_KINDS).map((r) => r.id)).toEqual([]);

    const p = poster();
    const r = reader();
    queue = new MediaQueue({ ...r.opts, ...p.opts });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(p.asked).toEqual([id]);
    expect(storedThumb(id)).toBe(join(tmpDir, "media", "v.mp4.poster.jpg"));

    // Same cycle or the next one, it is now a video the reader can look at.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(r.ids).toEqual([id]);
  });

  it("runs ahead of the description backlog and pays no throttle for it", async () => {
    setMediaVideoEnabled(true);
    seedImages(3);
    const video = seedPosterless("v", "2026-07-02T09:00:00.000Z");
    const p = poster();
    const r = reader();
    queue = new MediaQueue({ ...r.opts, ...p.opts });
    queue.start();

    // One pass: the poster and the image batch both start, because a local
    // ffmpeg seek is not something the model-call rate limit governs.
    await vi.advanceTimersByTimeAsync(0);
    expect(p.asked).toEqual([video]);
    expect(r.groups).toHaveLength(1);
  });

  it("stops asking about a file ffmpeg cannot open", async () => {
    // The claim has no status column to record the failure on, so the only
    // thing standing between a corrupt mp4 and an endless loop is memory.
    seedPosterless("v", "2026-07-02T10:00:00.000Z");
    const p = poster(false);
    const lines: string[] = [];
    queue = new MediaQueue({ ...p.opts, log: (line) => lines.push(line) });
    queue.start();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(p.asked).toHaveLength(3);
    expect(lines.some((l) => /no poster for wa:v/.test(l))).toBe(true);
  });

  it("leaves a video that already has a thumbnail alone", async () => {
    const p = poster();
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    queue = new MediaQueue(p.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(p.asked).toEqual([]);
  });

  it("has no switch of its own, and answers to none of the reader's", async () => {
    // Every other switch here gates a token or an outbound request. This is one
    // local seek over a file already on disk, and without it the video renders
    // as a paperclip whatever else the user has turned off.
    setMediaDescribeEnabled(false);
    setMediaBackfillEnabled(false);
    setMediaVideoEnabled(false);
    const id = seedPosterless("v", "2026-07-02T10:00:00.000Z");
    const p = poster();
    queue = new MediaQueue(p.opts);
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(p.asked).toEqual([id]);
  });
});

describe("transcription", () => {
  const heard: TranscribeResult = {
    transcript: "Haan bhai, kal shaam ko milte hain.",
    status: "done",
    model: "large-v3-turbo-q5_0",
    error: null,
  };

  /** A transcriber that records what it was handed. */
  function listener(
    outcome: () => TranscribeResult | Promise<TranscribeResult> = () => heard,
  ): { ids: string[]; transcribe: NonNullable<MediaQueueOptions["transcribe"]> } {
    const ids: string[] = [];
    return {
      ids,
      transcribe: async (row) => {
        ids.push(row.id);
        return outcome();
      },
    };
  }

  it("runs on a fresh install — whisper is local and costs no tokens (v6 §6)", async () => {
    seedAudio("a", "2026-07-02T10:00:01.000Z");
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    const l = listener();
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.ids).toEqual(["wa:a", "wa:v"]);
    expect(storedTranscript("wa:a")).toEqual({
      transcript: "Haan bhai, kal shaam ko milte hain.",
      transcript_status: "done",
      transcript_model: "large-v3-turbo-q5_0",
      transcript_error: null,
    });
  });

  it("both switches off means nothing is transcribed", async () => {
    setMediaVoiceNotesEnabled(false);
    setMediaVideoAudioEnabled(false);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener();
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(l.ids).toEqual([]);
    expect(storedTranscript("wa:a").transcript_status).toBe("pending");
  });

  it("a switch flipped back on reaches voice notes already on disk", async () => {
    setMediaVoiceNotesEnabled(false);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener();
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.ids).toEqual([]);

    setMediaVoiceNotesEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.ids).toEqual(["wa:a"]);
    expect(storedTranscript("wa:a").transcript_status).toBe("done");
  });

  it("voice notes and video audio gate separately", async () => {
    setMediaVideoAudioEnabled(false);
    seedAudio("a", "2026-07-02T10:00:01.000Z");
    seedVideo("v", "2026-07-02T10:00:00.000Z");
    const l = listener();
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.ids).toEqual(["wa:a"]);

    setMediaVideoAudioEnabled(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(l.ids).toEqual(["wa:a", "wa:v"]);
  });

  it("waits for every media read AND every link — v5 §5's priority, in order", async () => {
    setMediaVoiceNotesEnabled(true);
    setMediaLinkScrapeEnabled(true);
    seed("img", "2026-07-02T10:00:02.000Z");
    seedLink("l", "2026-07-02T10:00:01.000Z", "https://example.com/a");
    seedAudio("a", "2026-07-02T10:00:00.000Z");

    const order: string[] = [];
    queue = new MediaQueue({
      describe: async (row) => {
        order.push(`read ${row.id}`);
        return seen(row);
      },
      scrape: async (url) => {
        order.push(`fetch ${url}`);
        return { status: "done", scrapedText: "x", title: null, error: null };
      },
      transcribe: async (row) => {
        order.push(`hear ${row.id}`);
        return heard;
      },
    });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["read wa:img"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual(["read wa:img", "fetch https://example.com/a"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(order).toEqual([
      "read wa:img",
      "fetch https://example.com/a",
      "hear wa:a",
    ]);
  });

  it("a live attachment kills an in-flight transcription instead of waiting", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const order: string[] = [];
    let aborted = false;

    queue = new MediaQueue({
      describe: async (row) => {
        order.push(`read ${row.id}`);
        return seen(row);
      },
      // A transcription that only ends when it is killed: whisper on a long
      // recording is minutes of wall clock, which is the case that matters.
      transcribe: (row, opts) =>
        new Promise<TranscribeResult>((resolve) => {
          order.push(`hear ${row.id}`);
          opts.signal?.addEventListener("abort", () => {
            aborted = true;
            resolve({
              transcript: null,
              status: "error",
              model: "",
              error: "aborted",
            });
          });
        }),
    });
    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["hear wa:a"]);

    const liveId = seed("live", "2026-07-02T11:00:00.000Z");
    queue.enqueueLive(liveId);
    await vi.advanceTimersByTimeAsync(0);

    expect(aborted).toBe(true);
    expect(order).toEqual(["hear wa:a", "read wa:live"]);
    // The transcription that was killed recorded nothing — it is simply still
    // queued, exactly as a crash mid-read would leave it.
    expect(storedTranscript("wa:a")).toMatchObject({
      transcript_status: "pending",
      transcript_error: null,
    });
  });

  it("has its own gate — no model call is involved, so the reader switch is not one", async () => {
    setMediaDescribeEnabled(false);
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener();
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedTranscript("wa:a").transcript_status).toBe("done");
  });

  it("stores a degenerate verdict as unsupported with no transcript", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener(() => ({
      transcript: null,
      status: "unsupported",
      model: "large-v3-turbo-q5_0",
      error: "the same phrase repeated 6 times",
    }));
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedTranscript("wa:a")).toMatchObject({
      transcript: null,
      transcript_status: "unsupported",
      transcript_error: "the same phrase repeated 6 times",
    });
  });

  it("a partial transcript is stored as partial and never retried into a whole one", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener(() => ({
      transcript: "pehla hissa teesra hissa",
      status: "error",
      model: "large-v3-turbo-q5_0",
      error: "partial: 2 of 3 chunks (whisper-cli exit 3)",
    }));
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedTranscript("wa:a")).toMatchObject({
      transcript: "pehla hissa teesra hissa",
      transcript_status: "error",
      transcript_error: "partial: 2 of 3 chunks (whisper-cli exit 3)",
    });
    // Terminal: what came back IS the answer, so it is not asked again.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(l.ids).toEqual(["wa:a"]);
  });

  it("a failure with nothing recovered is retried a bounded number of times", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener(() => ({
      transcript: null,
      status: "error",
      model: "large-v3-turbo-q5_0",
      error: "whisper-cli exit 1",
    }));
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedTranscript("wa:a").transcript_status).toBe("pending");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(storedTranscript("wa:a")).toMatchObject({
      transcript_status: "error",
      transcript_error: "whisper-cli exit 1",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(l.ids).toHaveLength(3);
  });

  it("a transcriber that throws does not stop the loop", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    let first = true;
    const l = listener(() => {
      if (first) {
        first = false;
        throw new Error("spawn EACCES");
      }
      return heard;
    });
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(storedTranscript("wa:a").transcript_error).toBe("spawn EACCES");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(storedTranscript("wa:a").transcript_status).toBe("done");
  });

  it("costs no tokens, so it logs no run", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    const l = listener();
    queue = new MediaQueue({ ...reader().opts, transcribe: l.transcribe });
    queue.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM extraction_runs`).get(),
    ).toEqual({ n: 0 });
  });

  it("stopping mid-transcription records no verdict", async () => {
    setMediaVoiceNotesEnabled(true);
    seedAudio("a", "2026-07-02T10:00:00.000Z");
    let release: (() => void) | null = null;
    queue = new MediaQueue({
      ...reader().opts,
      transcribe: () =>
        new Promise<TranscribeResult>((resolve) => {
          release = () => resolve(heard);
        }),
    });
    queue.start();
    await vi.advanceTimersByTimeAsync(0);

    queue.stop();
    release!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(storedTranscript("wa:a")).toMatchObject({
      transcript: null,
      transcript_status: "pending",
    });
  });
});
