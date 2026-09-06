// ===========================================================================
// FIX-C1 — the media queue stands down under a hard stop.
//
// This is the lane that was actually visible on the user's 13.11.5 install.
// After the $3/hour ceiling latched at 15:12:59Z, the media queue kept claiming
// rows and asking the provider once every ~50 seconds for three hours; the gate
// refused each one before spawn, so `runs` filled with `media` rows reading
// "BUDGET_EXCEEDED … No process was spawned." (37 of them in the snapshot) and
// not one description was produced. The latch never clears on its own, so this
// was not a retry loop with an end.
//
// Held means: claim nothing, describe nothing, record nothing — the rows stay
// pending exactly where the tick after the operator's reset finds them. Local
// work (ffmpeg posters, whisper transcripts) costs no tokens and is NOT gated.
//
// Real temp DB, stubbed reader, fake timers. ZERO model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertSource, type PendingMediaRow } from "../db/ingest.js";
import { setMediaRatePerMin } from "../db/settings.js";
import {
  resetBudgetForTests,
  resetBudgetLatch,
  setModelActivityPaused,
  tripBudget,
} from "../providers/budget.js";
import type { DescribeBatchResult, DescribeResult } from "./describe.js";
import { MediaQueue, stopMediaQueue, type MediaQueueOptions } from "./queue.js";

let tmpDir: string;
let queue: MediaQueue | null = null;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-media-c1-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_MEDIA_DIR = join(tmpDir, "media");
  mkdirSync(join(tmpDir, "media"), { recursive: true });
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  vi.useFakeTimers();
  setMediaRatePerMin(60);
  resetBudgetForTests();
});

afterEach(() => {
  queue?.stop();
  queue = null;
  stopMediaQueue();
  resetBudgetForTests();
  vi.useRealTimers();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_MEDIA_DIR;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedImage(externalId: string, ts: string): string {
  return insertEvent({
    externalId,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId: null,
    actorId: null,
    ts,
    kind: "image",
    text: "",
    mediaPath: `/media/${externalId}.jpg`,
    rawJson: null,
    mediaMime: "image/jpeg",
  }).id;
}

const seen = (row: PendingMediaRow): DescribeResult => ({
  description: `saw ${row.id}`,
  status: "done",
  model: "haiku",
  error: null,
});

function reader(): { groups: string[][]; opts: MediaQueueOptions } {
  const groups: string[][] = [];
  return {
    groups,
    opts: {
      describe: async (row) => {
        groups.push([row.id]);
        return seen(row);
      },
      describeBatch: async (rows): Promise<DescribeBatchResult> => {
        groups.push(rows.map((r) => r.id));
        return {
          results: new Map(rows.map((r) => [r.id, seen(r)])),
          call: { description: null, status: "done", model: "haiku", error: null },
        };
      },
    },
  };
}

/** What the queue would claim next: `media_desc_status = 'pending'`. */
function pendingCount(): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM events
        WHERE media_path IS NOT NULL AND media_desc_status = 'pending'`,
    )
    .get() as { n: number };
  return row.n;
}

describe("FIX-C1 — the media queue holds under a latched budget", () => {
  it("claims nothing and asks nothing for five minutes, then drains the moment the latch clears", async () => {
    seedImage("a", "2026-07-02T10:00:02.000Z");
    seedImage("b", "2026-07-02T10:00:01.000Z");
    tripBudget("$3.05 spent in the last hour (ceiling $3)", Date.now());

    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();

    // Five minutes of ticks: on the user's install this window produced six
    // refused `media` runs and six error rows.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(r.groups).toEqual([]);
    // Nothing was recorded either — not a description, not a skip verdict.
    expect(pendingCount()).toBe(2);

    resetBudgetLatch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.groups).toEqual([["whatsapp:a", "whatsapp:b"]]);
    expect(pendingCount()).toBe(0);
  });

  it("the kill switch holds it the same way", async () => {
    seedImage("a", "2026-07-02T10:00:02.000Z");
    setModelActivityPaused(true, Date.now());

    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(r.groups).toEqual([]);
    expect(pendingCount()).toBe(1);

    setModelActivityPaused(false, Date.now());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(r.groups).toEqual([["whatsapp:a"]]);
  });

  it("with nothing held it reads as it always did", async () => {
    seedImage("a", "2026-07-02T10:00:02.000Z");
    const r = reader();
    queue = new MediaQueue(r.opts);
    queue.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.groups).toEqual([["whatsapp:a"]]);
  });
});
