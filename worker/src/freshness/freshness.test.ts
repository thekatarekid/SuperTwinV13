// ===========================================================================
// Freshness — "Knows you: X → Y" watermark math (build P2.4, spec §5.4).
//
// The invariant under test: the chip renders the UNDERSTOOD range (dispatched
// events), never the captured range — a freshly imported but unread year of
// history must NOT widen "knows you", and the left edge crawls backward only
// as dispatch works through it.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { markSourceBackfillComplete } from "../db/watermarks.js";
import {
  formatLeftEdge,
  formatRightEdge,
  freshnessDetail,
  freshnessOverview,
  knowsYouLabel,
  sourceFreshness,
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

  it("detail line: importing + lag states", () => {
    expect(
      freshnessDetail(
        {
          captured_to: "2026-08-28T11:58:00.000Z",
          understood_from: "2024-01-05T00:00:00.000Z",
          backfill_complete: false,
          understood_percent: 72,
          lag_minutes: 3,
        },
        NOW,
      ),
    ).toBe("capturing live ✓ · importing history: at 2024 (72%) · understanding: caught up");
    expect(
      freshnessDetail(
        {
          captured_to: "2026-08-28T11:58:00.000Z",
          understood_from: "2026-08-01T00:00:00.000Z",
          backfill_complete: true,
          understood_percent: 80,
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

  it("lag: an undispatched event older than the 10-min promise", () => {
    const stale: EventEnvelope = {
      ...env("whatsapp", "goa@g.us", "2026-08-28T11:46:00.000Z", "stuck"),
      capturedAt: "2026-08-28T11:46:00.000Z",
    };
    appendEvents([stale], NOW);
    const f = sourceFreshness("whatsapp", NOW);
    expect(f.lag_minutes).toBe(14);
    expect(f.detail).toContain("catching up — 14 min behind");
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
  });

});
