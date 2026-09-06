// ===========================================================================
// The day scrubber stops full-scanning the log on every visit (FIX-C4).
//
// WHAT WAS BROKEN. Opening the Timeline tab fired /api/timeline/days, whose
// counts come from `GROUP BY substr(ts,1,10)` over the WHOLE event log. No
// index can answer that — SQLite reads every row and builds a temporary
// b-tree — and it ran again on every single mount. Measured at 266 ms over a
// 160,200-event corpus with a warm cache, on a machine doing nothing else;
// the user's worker was at 379% CPU with a WhatsApp import writing
// 5,000-message batches into a 1 GB database with an 801 MB WAL beside it,
// and their whole tab took 15 s.
//
// THE CONTRACT HELD HERE. The answer is a snapshot:
//
//   * an IDLE log is never re-counted — the scan happens once and every later
//     visit is one O(1) `MAX(rowid)` probe;
//   * while the log IS moving (an import) the scan is bounded to once per
//     DAYS_SNAPSHOT_MS, so a burst of tab switches cannot stack scans on a
//     worker that is already behind;
//   * the snapshot does expire: a new day is on the scrubber after the window.
//
// Identity (`toBe`) is the probe: the same object back means no recount
// happened. The clock is injected, so nothing here waits on wall time. Zero
// model calls.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent } from "../db/eventlog.js";
import { resetTimelineDaysCache, timelineDays } from "./grounded-routes.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-days-cache-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetTimelineDaysCache();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
  resetTimelineDaysCache();
});

function seed(ts: string): void {
  appendEvent({
    ts,
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "911234@g.us",
    actor: "contact:rohan",
    roles: { sender: "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: `at ${ts}` },
  });
}

const T0 = Date.parse("2026-09-06T10:00:00.000Z");
const MINUTE = 60_000;

describe("FIX-C4 · the day scrubber is a snapshot, not a scan per visit", () => {
  it("never re-counts a log that has not been written to", () => {
    seed("2026-09-01T10:00:00.000Z");
    seed("2026-09-02T10:00:00.000Z");

    const first = timelineDays(90, T0);
    expect(first.days.map((d) => d.day)).toEqual(["2026-09-02", "2026-09-01"]);

    // Ten minutes later, still nothing written: the same object comes back,
    // which is only possible if the aggregate did not run again.
    expect(timelineDays(90, T0 + 10 * MINUTE)).toBe(first);
    expect(timelineDays(90, T0 + 60 * MINUTE)).toBe(first);
  });

  it("bounds the scan to once per window while an import is landing", () => {
    seed("2026-09-01T10:00:00.000Z");
    const first = timelineDays(90, T0);

    // The importer writes. Inside the window the scrubber keeps the answer it
    // has — a count that is seconds behind reads identically on screen, and
    // the point is that four tab switches cannot stack four full scans.
    seed("2026-09-03T10:00:00.000Z");
    expect(timelineDays(90, T0 + 1_000)).toBe(first);
    expect(timelineDays(90, T0 + 20_000)).toBe(first);

    // Past the window, the new day is there.
    const later = timelineDays(90, T0 + 31_000);
    expect(later).not.toBe(first);
    expect(later.days.map((d) => d.day)).toEqual(["2026-09-03", "2026-09-01"]);
  });

  it("counts and sources are the same answer the scan gave", () => {
    seed("2026-09-01T10:00:00.000Z");
    seed("2026-09-01T11:00:00.000Z");
    appendEvent({
      ts: "2026-09-02T09:00:00.000Z",
      source: "browser",
      kind: "browser.visit",
      origin: "live",
      streamKey: "tab:1",
      actor: "self",
      roles: { sender: "self", audience: [], receiver: [], mentions: [] },
      payload: { url: "https://example.com", title: "example" },
    });

    const view = timelineDays(90, T0);
    expect(view.days).toEqual([
      { day: "2026-09-02", count: 1 },
      { day: "2026-09-01", count: 2 },
    ]);
    expect(view.sources).toEqual(["browser", "wa"]);
  });

  it("a deletion is never served stale — a shrinking log invalidates at once", () => {
    seed("2026-09-01T10:00:00.000Z");
    seed("2026-09-02T10:00:00.000Z");
    const before = timelineDays(90, T0);
    expect(before.days).toHaveLength(2);

    // "Forget this source" / "delete everything": rows go, and MAX(rowid)
    // moves BACK. Inside the window, but the answer is re-taken anyway.
    getDb().prepare(`DELETE FROM events WHERE ts LIKE '2026-09-02%'`).run();
    const after = timelineDays(90, T0 + 1_000);
    expect(after).not.toBe(before);
    expect(after.days.map((d) => d.day)).toEqual(["2026-09-01"]);
  });

  it("a wiped or swapped database is never served the previous log's counts", () => {
    seed("2026-09-01T10:00:00.000Z");
    const before = timelineDays(90, T0);
    expect(before.days).toHaveLength(1);

    // A different home on the same tick — the snapshot must not survive it.
    const other = mkdtempSync(join(tmpdir(), "supertwin-days-cache-2-"));
    process.env.SUPERTWIN_DB_PATH = join(other, "st.db");
    closeDb();
    runMigrations();
    try {
      const after = timelineDays(90, T0);
      expect(after).not.toBe(before);
      expect(after.days).toEqual([]);
    } finally {
      closeDb();
      rmSync(other, { recursive: true, force: true });
    }
  });
});
