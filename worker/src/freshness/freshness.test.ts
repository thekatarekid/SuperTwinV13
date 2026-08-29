// ===========================================================================
// Freshness — "Knows you: X → Y" watermark math (build P2.4, spec §5.4).
//
// The invariant under test: the chip renders the UNDERSTOOD range (dispatched
// events), never the captured range — a freshly imported but unread year of
// history must NOT widen "knows you", and the left edge crawls backward only
// as dispatch works through it.
//
// And the defect this file now pins down: shipped 13.4.1 counted IMPORTED
// HISTORY in the lag number, so importing a few months of browser history made
// the chip read "catching up — 236 min behind" and climb by a minute a minute,
// forever, with no user action that could move it. The lag is the LIVE promise
// only; imported history is a finite backlog that shrinks; and with neither
// waiting, the chip says "up to date" instead of going quiet.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { markSourceBackfillComplete } from "../db/watermarks.js";
import {
  formatLag,
  formatLeftEdge,
  formatRightEdge,
  freshnessDetail,
  freshnessOverview,
  freshnessStatus,
  knowsYouLabel,
  sourceFreshness,
  statusRank,
  FRESHNESS_PROMISE_MIN,
} from "./index.js";

const NOW = Date.parse("2026-08-28T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-freshness-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function env(source: string, key: string, ts: string, text: string): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source,
    kind: `${source}.message`,
    origin: "live",
    streamKey: key,
    actor: "contact:x",
    roles: { sender: "contact:x", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  };
}

/** An imported-history event: old ts, captured_at fixed at import time. */
function backfill(source: string, key: string, ts: string, capturedAt: string, text: string): EventEnvelope {
  return { ...env(source, key, ts, text), origin: "backfill", capturedAt };
}

function markDispatched(ids: string[]): void {
  const db = getDb();
  const stmt = db.prepare(`UPDATE events SET dispatched_at = ? WHERE id = ?`);
  for (const id of ids) stmt.run("2026-08-28T11:59:00.000Z", id);
}

describe("formatting", () => {
  it("left edge: month+year inside two years, bare year beyond", () => {
    expect(formatLeftEdge("2026-03-05T00:00:00.000Z", NOW)).toBe("Mar 2026");
    expect(formatLeftEdge("2025-01-15T00:00:00.000Z", NOW)).toBe("Jan 2025");
    expect(formatLeftEdge("2019-06-01T00:00:00.000Z", NOW)).toBe("2019");
  });

  it("right edge: relative, coarsening with age", () => {
    expect(formatRightEdge("2026-08-28T11:59:30.000Z", NOW)).toBe("just now");
    expect(formatRightEdge("2026-08-28T11:58:00.000Z", NOW)).toBe("2 min ago");
    expect(formatRightEdge("2026-08-28T10:00:00.000Z", NOW)).toBe("2h ago");
    expect(formatRightEdge("2026-08-25T12:00:00.000Z", NOW)).toBe("3d ago");
    expect(formatRightEdge("2026-08-01T12:00:00.000Z", NOW)).toBe("Aug 1");
  });

  it("label needs both edges", () => {
    expect(knowsYouLabel(null, "2026-08-28T11:58:00.000Z", NOW)).toBeNull();
    expect(knowsYouLabel("2024-01-05T00:00:00.000Z", null, NOW)).toBeNull();
    expect(knowsYouLabel("2024-01-05T00:00:00.000Z", "2026-08-28T11:58:00.000Z", NOW)).toBe(
      "Knows you: 2024 → 2 min ago",
    );
  });

  it("a lag reads as a clock, not as unbounded minutes", () => {
    expect(formatLag(14)).toBe("14 min behind");
    expect(formatLag(59)).toBe("59 min behind");
    expect(formatLag(120)).toBe("2h behind");
    expect(formatLag(236)).toBe("3h 56m behind");
    expect(formatLag(1440)).toBe("a day behind");
    expect(formatLag(4320)).toBe("3 days behind");
  });
});

describe("freshnessStatus — the verdict the chip shows", () => {
  const base = { event_count: 10, pending_live_count: 0, pending_backfill_count: 0, lag_minutes: null };

  it("THE SETTLED CASE: nothing waiting says so out loud", () => {
    expect(freshnessStatus(base)).toEqual({ status: "up_to_date", label: "up to date" });
  });

  it("live events inside the 10-minute promise are still up to date", () => {
    expect(
      freshnessStatus({ ...base, pending_live_count: 3, lag_minutes: FRESHNESS_PROMISE_MIN }),
    ).toEqual({ status: "up_to_date", label: "up to date" });
  });

  it("a breached live promise is the lag chip", () => {
    expect(freshnessStatus({ ...base, pending_live_count: 3, lag_minutes: 14 })).toEqual({
      status: "catching_up",
      label: "catching up — 14 min behind",
    });
  });

  it("REGRESSION: imported history is a shrinking count, never climbing minutes", () => {
    // The 13.4.1 shape: thousands of backfill rows imported hours ago and
    // nothing live waiting. It must NOT read as a lag.
    const v = freshnessStatus({ ...base, pending_backfill_count: 2569, lag_minutes: null });
    expect(v.status).toBe("importing_history");
    expect(v.label).toBe("importing history — 2,569 events left");
    expect(v.label).not.toMatch(/behind/);
  });

  it("singular history event reads naturally", () => {
    expect(freshnessStatus({ ...base, pending_backfill_count: 1 }).label).toBe(
      "importing history — 1 event left",
    );
  });

  it("a live breach outranks the history import", () => {
    expect(
      freshnessStatus({ ...base, pending_backfill_count: 2569, pending_live_count: 1, lag_minutes: 40 })
        .status,
    ).toBe("catching_up");
  });

  it("an empty log is no_data", () => {
    expect(freshnessStatus({ ...base, event_count: 0 })).toEqual({
      status: "no_data",
      label: "nothing captured yet",
    });
  });

  it("ranks worst-first", () => {
    expect(statusRank("catching_up")).toBeGreaterThan(statusRank("importing_history"));
    expect(statusRank("importing_history")).toBeGreaterThan(statusRank("up_to_date"));
    expect(statusRank("up_to_date")).toBeGreaterThan(statusRank("no_data"));
  });
});

describe("detail line", () => {
  it("shows the history queue as a shrinking count, then caught up", () => {
    expect(
      freshnessDetail(
        {
          captured_to: "2026-08-28T11:58:00.000Z",
          understood_from: "2024-01-05T00:00:00.000Z",
          backfill_complete: false,
          understood_percent: 72,
          event_count: 100,
          pending_live_count: 0,
          pending_backfill_count: 28,
          lag_minutes: null,
        },
        NOW,
      ),
    ).toBe("capturing live ✓ · importing history: at 2024 (72%, 28 left) · understanding: caught up");
  });

  it("names a breached live promise", () => {
    expect(
      freshnessDetail(
        {
          captured_to: "2026-08-28T11:58:00.000Z",
          understood_from: "2026-08-01T00:00:00.000Z",
          backfill_complete: true,
          understood_percent: 80,
          event_count: 10,
          pending_live_count: 2,
          pending_backfill_count: 0,
          lag_minutes: 14,
        },
        NOW,
      ),
    ).toBe("capturing live ✓ · catching up — 14 min behind");
  });
});

describe("understood vs captured", () => {
  it("undispatched history widens capture but NOT knows-you", () => {
    const r = appendEvents(
      [
        env("whatsapp", "goa@g.us", "2024-01-05T00:00:00.000Z", "old history"),
        env("whatsapp", "goa@g.us", "2026-08-28T11:58:00.000Z", "fresh msg"),
      ],
      NOW,
    );
    // Only the fresh event has been read by a tick.
    markDispatched([r.ids[1]]);
    const f = sourceFreshness("whatsapp", NOW);
    expect(f.captured_from).toBe("2024-01-05T00:00:00.000Z");
    expect(f.understood_from).toBe("2026-08-28T11:58:00.000Z");
    expect(f.label).toBe("Knows you: Aug 2026 → 2 min ago");
    expect(f.pending_count).toBe(1);
    expect(f.understood_percent).toBe(50);
  });

  it("left edge crawls backward as backfill dispatch catches up", () => {
    const r = appendEvents(
      [
        env("whatsapp", "goa@g.us", "2024-01-05T00:00:00.000Z", "jan 24"),
        env("whatsapp", "goa@g.us", "2025-06-01T00:00:00.000Z", "jun 25"),
        env("whatsapp", "goa@g.us", "2026-08-28T11:58:00.000Z", "now-ish"),
      ],
      NOW,
    );
    markDispatched([r.ids[2]]);
    expect(sourceFreshness("whatsapp", NOW).understood_from).toBe("2026-08-28T11:58:00.000Z");
    markDispatched([r.ids[1]]);
    expect(sourceFreshness("whatsapp", NOW).understood_from).toBe("2025-06-01T00:00:00.000Z");
    markDispatched([r.ids[0]]);
    const f = sourceFreshness("whatsapp", NOW);
    expect(f.understood_from).toBe("2024-01-05T00:00:00.000Z");
    expect(f.understood_percent).toBe(100);
  });

  it("lag: an undispatched LIVE event older than the 10-min promise", () => {
    const stale: EventEnvelope = {
      ...env("whatsapp", "goa@g.us", "2026-08-28T11:46:00.000Z", "stuck"),
      capturedAt: "2026-08-28T11:46:00.000Z",
    };
    appendEvents([stale], NOW);
    const f = sourceFreshness("whatsapp", NOW);
    expect(f.lag_minutes).toBe(14);
    expect(f.status).toBe("catching_up");
    expect(f.status_label).toBe("catching up — 14 min behind");
    expect(f.detail).toContain("catching up — 14 min behind");
  });

  it("REGRESSION: a fat history import is not a lag", () => {
    // Exactly the reporting user's shape: 2,500 browser-history rows landed
    // four hours ago, nothing live waiting. 13.4.1 read this as
    // "catching up — 236 min behind" and climbed.
    const rows: EventEnvelope[] = [];
    for (let i = 0; i < 12; i += 1) {
      rows.push(
        backfill(
          "browser",
          `chain-${i}`,
          `2026-05-31T0${i % 10}:00:00.000Z`,
          "2026-08-28T08:04:00.000Z", // imported ~4 hours before NOW
          `history ${i}`,
        ),
      );
    }
    const live = env("browser", "chain-live", "2026-08-28T11:58:00.000Z", "fresh");
    const r = appendEvents([...rows, live], NOW);
    markDispatched([r.ids[0], r.ids[r.ids.length - 1]]);

    const f = sourceFreshness("browser", NOW);
    expect(f.pending_backfill_count).toBe(11);
    expect(f.pending_live_count).toBe(0);
    expect(f.lag_minutes).toBeNull();
    expect(f.status).toBe("importing_history");
    expect(f.status_label).toBe("importing history — 11 events left");
    expect(f.status_label).not.toMatch(/behind/);
  });

  it("THE SETTLED CASE, end to end: everything dispatched reads 'up to date'", () => {
    const r = appendEvents(
      [
        env("whatsapp", "goa@g.us", "2026-08-28T11:00:00.000Z", "a"),
        env("whatsapp", "goa@g.us", "2026-08-28T11:58:00.000Z", "b"),
      ],
      NOW,
    );
    markDispatched(r.ids);
    const f = sourceFreshness("whatsapp", NOW);
    expect(f.pending_count).toBe(0);
    expect(f.lag_minutes).toBeNull();
    expect(f.status).toBe("up_to_date");
    expect(f.status_label).toBe("up to date");
    expect(freshnessOverview(NOW).status_label).toBe("up to date");
  });

  it("backfill_complete follows the sealed watermarks", () => {
    appendEvents([env("whatsapp", "goa@g.us", "2026-08-28T11:58:00.000Z", "m")], NOW);
    expect(sourceFreshness("whatsapp", NOW).backfill_complete).toBe(false);
    markSourceBackfillComplete("whatsapp");
    expect(sourceFreshness("whatsapp", NOW).backfill_complete).toBe(true);
  });
});

describe("overview + per-stream edges", () => {
  it("header chip spans all sources' understood ranges", () => {
    const r1 = appendEvents([env("whatsapp", "goa@g.us", "2024-01-05T00:00:00.000Z", "wa")], NOW);
    const r2 = appendEvents([env("browser", "chain-1", "2026-08-28T11:58:00.000Z", "web")], NOW);
    markDispatched([r1.ids[0], r2.ids[0]]);
    const o = freshnessOverview(NOW);
    expect(o.sources.map((s) => s.source_id).sort()).toEqual(["browser", "whatsapp"]);
    expect(o.label).toBe("Knows you: 2024 → 2 min ago");
    expect(o.lag_minutes).toBeNull();
    expect(o.status).toBe("up_to_date");
  });

  it("an empty log reports no_data, not a null-shaped chip", () => {
    const o = freshnessOverview(NOW);
    expect(o.sources).toEqual([]);
    expect(o.status).toBe("no_data");
    expect(o.status_label).toBe("nothing captured yet");
  });

  it("the header equals the WORST source, and its lag is the worst breach", () => {
    // browser: a genuinely stuck live event. whatsapp: history still importing.
    appendEvents(
      [
        {
          ...env("browser", "chain-1", "2026-08-28T11:20:00.000Z", "stuck"),
          capturedAt: "2026-08-28T11:20:00.000Z",
        },
      ],
      NOW,
    );
    appendEvents(
      [backfill("whatsapp", "goa@g.us", "2024-01-05T00:00:00.000Z", "2026-08-28T08:00:00.000Z", "old")],
      NOW,
    );

    const o = freshnessOverview(NOW);
    const worst = o.sources.reduce((acc, s) =>
      statusRank(s.status) > statusRank(acc.status) ? s : acc,
    );
    expect(o.status).toBe(worst.status);
    expect(o.status).toBe("catching_up");
    expect(o.lag_minutes).toBe(40);
    expect(o.status_label).toBe("catching up — 40 min behind");
    // The history queue is still reported, just not as the headline.
    expect(o.pending_backfill_count).toBe(1);
  });

  it("a source inside the promise never drags the header into a lag", () => {
    appendEvents(
      [
        {
          ...env("browser", "chain-1", "2026-08-28T11:55:00.000Z", "recent"),
          capturedAt: "2026-08-28T11:55:00.000Z",
        },
      ],
      NOW,
    );
    const o = freshnessOverview(NOW);
    expect(o.sources[0].lag_minutes).toBe(5);
    expect(o.lag_minutes).toBeNull();
    expect(o.status).toBe("up_to_date");
  });
});
