// ===========================================================================
// Dual watermarks (build item 1.1, arch §2.2; evals A-011…A-020).
//
// The whole test is one invariant, stated twice: the live head only ever moves
// UP and the backfill floor only ever moves DOWN, and running both at once
// leaves each where its own rule put it. A single cursor would fail every case
// below, which is why there are two.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "./connection.js";
import { upsertSource, upsertStream } from "./ingest.js";
import {
  markBackfillComplete,
  markSourceBackfillComplete,
  noteBackfillEvent,
  noteIngestedEvent,
  noteLiveEvent,
  readWatermark,
  resetSourceWatermarks,
} from "./watermarks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-watermarks-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedStream(ext = "mom@x"): string {
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  return upsertStream({ sourceId: "whatsapp", sourceExtId: ext, name: "Mom", kind: "dm" });
}

describe("live head — forward only", () => {
  it("lifts on a newer event and records which event it was", () => {
    const s = seedStream();
    noteLiveEvent(s, "2026-08-01T10:00:00.000Z", "mom@x/A");
    noteLiveEvent(s, "2026-08-01T11:00:00.000Z", "mom@x/B");
    const w = readWatermark(s)!;
    expect(w.live_high_ts).toBe("2026-08-01T11:00:00.000Z");
    expect(w.live_high_external_id).toBe("mom@x/B");
  });

  it("is never pulled back by an out-of-order replay", () => {
    const s = seedStream();
    noteLiveEvent(s, "2026-08-01T11:00:00.000Z", "mom@x/B");
    noteLiveEvent(s, "2026-08-01T09:00:00.000Z", "mom@x/OLD");
    const w = readWatermark(s)!;
    expect(w.live_high_ts).toBe("2026-08-01T11:00:00.000Z");
    expect(w.live_high_external_id).toBe("mom@x/B");
  });
});

describe("backfill floor — backward only", () => {
  it("lowers as older history pages land", () => {
    const s = seedStream();
    noteBackfillEvent(s, "2026-07-01T00:00:00.000Z");
    noteBackfillEvent(s, "2025-01-01T00:00:00.000Z");
    noteBackfillEvent(s, "2019-03-04T00:00:00.000Z");
    expect(readWatermark(s)!.backfill_low_ts).toBe("2019-03-04T00:00:00.000Z");
  });

  it("is never lifted by a newer history row", () => {
    const s = seedStream();
    noteBackfillEvent(s, "2019-03-04T00:00:00.000Z");
    noteBackfillEvent(s, "2026-07-01T00:00:00.000Z");
    expect(readWatermark(s)!.backfill_low_ts).toBe("2019-03-04T00:00:00.000Z");
  });
});

describe("the two cursors move in OPPOSITE directions and never touch", () => {
  it("a live message during a backfill lifts only the head", () => {
    const s = seedStream();
    // Six history pages, walking backwards...
    const pages = [
      "2026-06-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z",
    ];
    let previousLow: string | null = null;
    for (const [i, ts] of pages.entries()) {
      noteIngestedEvent(s, ts, { historical: true });
      // ...and a live message arriving mid-page, walking forwards.
      const liveTs = `2026-08-0${i + 1}T10:00:00.000Z`;
      noteIngestedEvent(s, liveTs, { historical: false, externalId: `mom@x/L${i}` });

      const w = readWatermark(s)!;
      expect(w.backfill_low_ts).toBe(ts);
      if (previousLow) expect(w.backfill_low_ts! < previousLow).toBe(true);
      previousLow = w.backfill_low_ts;
      expect(w.live_high_ts).toBe(liveTs);
    }

    const final = readWatermark(s)!;
    expect(final.backfill_low_ts).toBe("2026-01-01T00:00:00.000Z");
    expect(final.live_high_ts).toBe("2026-08-06T10:00:00.000Z");
    expect(final.backfill_complete).toBe(false);
  });

  it("keeps the two cursors per stream, not per source", () => {
    const a = seedStream("a@x");
    const b = seedStream("b@x");
    noteLiveEvent(a, "2026-08-01T10:00:00.000Z", "a@x/1");
    noteBackfillEvent(b, "2019-01-01T00:00:00.000Z");
    expect(readWatermark(a)!.live_high_ts).toBe("2026-08-01T10:00:00.000Z");
    expect(readWatermark(a)!.backfill_low_ts).toBeNull();
    expect(readWatermark(b)!.live_high_ts).toBeNull();
    expect(readWatermark(b)!.backfill_low_ts).toBe("2019-01-01T00:00:00.000Z");
  });
});

describe("completion + reset", () => {
  it("reads null for a stream that has ingested nothing", () => {
    const s = seedStream();
    expect(readWatermark(s)).toBeNull();
  });

  it("marks completion stickily, without disturbing either cursor", () => {
    const s = seedStream();
    noteBackfillEvent(s, "2019-01-01T00:00:00.000Z");
    noteLiveEvent(s, "2026-08-01T10:00:00.000Z", "mom@x/1");
    markBackfillComplete(s);
    noteBackfillEvent(s, "2018-01-01T00:00:00.000Z");
    const w = readWatermark(s)!;
    expect(w.backfill_complete).toBe(true);
    expect(w.backfill_low_ts).toBe("2018-01-01T00:00:00.000Z");
    expect(w.live_high_ts).toBe("2026-08-01T10:00:00.000Z");
  });

  it("marks every stream of a source complete, even one with no events", () => {
    const a = seedStream("a@x");
    const quiet = seedStream("quiet@x");
    noteLiveEvent(a, "2026-08-01T10:00:00.000Z", "a@x/1");
    expect(markSourceBackfillComplete("whatsapp")).toEqual({ streams: 2, sealed: 2 });
    expect(readWatermark(a)!.backfill_complete).toBe(true);
    expect(readWatermark(quiet)!.backfill_complete).toBe(true);
  });

  it("re-run seals only the streams created since the last pass", () => {
    const first = seedStream("a@x");
    markSourceBackfillComplete("whatsapp");

    // The import's tail: a stream that did not exist at the first pass, and
    // whose watermark row is created by the backfill cursor WITHOUT the flag.
    const late = seedStream("late@x");
    noteBackfillEvent(late, "2019-01-01T00:00:00.000Z");
    expect(readWatermark(late)!.backfill_complete).toBe(false);

    expect(markSourceBackfillComplete("whatsapp")).toEqual({ streams: 2, sealed: 1 });
    expect(readWatermark(late)!.backfill_complete).toBe(true);
    expect(readWatermark(first)!.backfill_complete).toBe(true);

    // Nothing left to do: a third pass writes nothing.
    expect(markSourceBackfillComplete("whatsapp")).toEqual({ streams: 2, sealed: 0 });
  });

  it("drops a source's watermarks on reset", () => {
    const s = seedStream();
    noteLiveEvent(s, "2026-08-01T10:00:00.000Z", "mom@x/1");
    resetSourceWatermarks("whatsapp");
    expect(readWatermark(s)).toBeNull();
  });

  it("ignores a blank stream id or timestamp instead of writing a junk row", () => {
    const s = seedStream();
    noteLiveEvent("", "2026-08-01T10:00:00.000Z");
    noteBackfillEvent(s, "");
    expect(readWatermark(s)).toBeNull();
  });
});
