// ===========================================================================
// Per-source status (V6 P1 S6d L6) — the read a Library sub-tab makes about
// its OWN source.
//
// The defect this pins: status was one top-right chip that summed every
// source, so a two-source machine showed a range neither source has and a
// backlog neither source carries. These tests assert the per-source read never
// mixes: whatsapp's numbers are whatsapp's, browser's are browser's, and the
// window in force is the source's own consent row.
//
// Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents, grantConsent, setConsentState } from "../db/v6core.js";
import { freshnessOverview } from "../freshness/index.js";
import { floorLabel, sourceStatus, windowLabel } from "./source-status.js";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-source-status-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function env(source: string, key: string, ts: string, n: number): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source,
    kind: `${source}.message`,
    // The backlog the panel reports is the imported-history one, so the seeds
    // are backfill rows — exactly what a history import lands.
    origin: "backfill",
    streamKey: key,
    actor: "contact:x",
    roles: { sender: "contact:x", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text: `event ${n}` },
  };
}

/**
 * Seed `total` events for a source and mark `understood` of them understood.
 *
 * FIX-C5: "understood" is membership of an episode, not `dispatched_at` — the
 * dispatcher's flag is also stamped on every archive row, so it counted
 * history nobody had read. The seed therefore does both halves of what a real
 * pass does: it dispatches the rows AND files them under an episode.
 */
let episodeSeq = 0;

function seed(source: string, key: string, ts: string, total: number, understood: number): void {
  const rows: EventEnvelope[] = [];
  for (let i = 0; i < total; i += 1) rows.push(env(source, key, ts, i));
  const r = appendEvents(rows, NOW);
  const db = getDb();
  const mark = db.prepare(`UPDATE events SET dispatched_at = ? WHERE id = ?`);
  const read = r.ids.slice(0, understood);
  for (const id of read) mark.run(new Date(NOW).toISOString(), id);
  if (read.length > 0) {
    const episodeId = `ep_seed_${(episodeSeq += 1)}`;
    db.prepare(`INSERT INTO episodes (id, state, created_by) VALUES (?, 'open', 'test')`).run(episodeId);
    addEpisodeEvents(episodeId, read, "test");
  }
}

describe("windowLabel — the window in force, as one honest phrase", () => {
  it("says index everything + the understand floor", () => {
    expect(windowLabel({ index_all: true, index_from: null, understand_from: "2026-08-07T00:00:00.000Z" })).toBe(
      "index everything · understand from 7 Aug 2026",
    );
  });

  it("never invents an understand window when nothing goes to the model", () => {
    expect(windowLabel({ index_all: true, index_from: null, understand_from: null })).toBe(
      "index everything · understand: nothing goes to the model",
    );
  });

  it("renders a bounded index floor", () => {
    expect(
      windowLabel({
        index_all: false,
        index_from: "2025-01-15T00:00:00.000Z",
        understand_from: "2026-08-07T00:00:00.000Z",
      }),
    ).toBe("index from 15 Jan 2025 · understand from 7 Aug 2026");
  });

  it("a source with no consent row has no window, and says so", () => {
    expect(windowLabel(null)).toBe("no window — not connected");
  });

  it("formats a floor as a recognisable date", () => {
    expect(floorLabel("2026-08-07T14:49:41.661Z")).toBe("7 Aug 2026");
  });
});

describe("sourceStatus — one source, its own numbers", () => {
  it("THE DEFECT: two importing sources never share a range or a backlog", () => {
    // The reporting user's shape: browser reaching back years, whatsapp not.
    seed("browser", "example.com", "2010-05-02T09:00:00.000Z", 10, 7);
    seed("whatsapp", "goa@g.us", "2023-04-11T09:00:00.000Z", 10, 9);
    grantConsent({ source: "browser", indexAll: true, understandFrom: "2026-08-07T00:00:00.000Z" });
    grantConsent({ source: "whatsapp", indexAll: true, understandFrom: "2026-08-07T00:00:00.000Z" });

    const browser = sourceStatus("browser", NOW);
    const whatsapp = sourceStatus("whatsapp", NOW);

    // Each source's coverage is ITS OWN — 2010 belongs to browser alone.
    expect(browser.coverage.label).toContain("2010");
    expect(whatsapp.coverage.label).toContain("2023");
    expect(whatsapp.coverage.label).not.toContain("2010");

    // Each source's backlog is ITS OWN — 3 and 1, never the sum 4.
    expect(browser.progress.pending_backfill_count).toBe(3);
    expect(whatsapp.progress.pending_backfill_count).toBe(1);
    expect(browser.progress.status_label).toBe("importing history — 3 events left");
    expect(whatsapp.progress.status_label).toBe("importing history — 1 event left");

    // And the combined chip really is a sum of exactly these two — which is
    // why it cannot be shown inside either source's panel.
    const overview = freshnessOverview(NOW);
    expect(overview.pending_backfill_count).toBe(4);
  });

  it("carries the connection state and the window in force off the consent row", () => {
    seed("whatsapp", "goa@g.us", "2026-09-01T09:00:00.000Z", 4, 4);
    grantConsent({ source: "whatsapp", indexAll: true, understandFrom: "2026-08-07T00:00:00.000Z" });

    const s = sourceStatus("whatsapp", NOW);
    expect(s.source_id).toBe("whatsapp");
    expect(s.connection.state).toBe("connected");
    expect(s.connection.capturing).toBe(true);
    expect(s.windows).toEqual({
      index_all: true,
      index_from: null,
      understand_from: "2026-08-07T00:00:00.000Z",
    });
    expect(s.window_label).toBe("index everything · understand from 7 Aug 2026");
    expect(s.progress.status).toBe("up_to_date");
    expect(s.progress.understood_percent).toBe(100);
  });

  it("a paused source reads paused, not connected — and keeps its coverage", () => {
    seed("screen", "Xcode", "2026-09-05T09:00:00.000Z", 2, 2);
    grantConsent({ source: "screen", indexAll: true, understandFrom: null });
    setConsentState("screen", "paused");

    const s = sourceStatus("screen", NOW);
    expect(s.connection.state).toBe("paused");
    expect(s.connection.capturing).toBe(false);
    expect(s.window_label).toBe("index everything · understand: nothing goes to the model");
    expect(s.coverage.label).not.toBeNull();
  });

  it("a source with no consent row is not connected and claims no window", () => {
    const s = sourceStatus("screen", NOW);
    expect(s.connection.state).toBe("not_connected");
    expect(s.windows).toBeNull();
    expect(s.window_label).toBe("no window — not connected");
    expect(s.progress.status).toBe("no_data");
    expect(s.progress.event_count).toBe(0);
    expect(s.coverage.label).toBeNull();
  });
});
