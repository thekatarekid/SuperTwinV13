// ===========================================================================
// FIX-C5 — the two surfaces that publish "understood" now publish the SAME
// number, and it is the number of events the twin has actually read.
//
// Before this fix there were two definitions and neither measured
// understanding. On the reporting user's live home, at the same instant:
//
//   freshness/index.ts   dispatched_at IS NOT NULL  → 16,596 for browser,
//                        understood_from 2010-09-27, "Knows you: 2010 → 2h ago"
//   library/storage.ts   origin <> 'archive'        → 12,120 across two sources
//   the truth            episode membership         → 1,061
//
// The first number is the dispatcher's own flag, which the consent gate stamps
// on every archive row exactly so no lane picks it up again; the second is the
// QUEUE — what we intend to read. This suite pins the corpus that produced
// that divergence, in miniature, and asserts the three numbers are now one.
//
// Zero model calls. SQLite only.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvents, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { sourceStorage } from "../library/storage.js";
import { sourceFreshness } from "./index.js";
import { understoodBySource, understoodForSource } from "./understood.js";

const NOW = Date.parse("2026-09-06T16:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-understood-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function ev(source: string, ts: string, text: string, origin: "live" | "archive" = "live"): EventEnvelope {
  return {
    ts,
    capturedAt: ts,
    source,
    kind: `${source}.message`,
    origin,
    streamKey: `${source}-stream`,
    actor: "contact:x",
    roles: { sender: "contact:x", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  };
}

let episodeSeq = 0;

function understand(ids: string[]): void {
  const db = getDb();
  const id = `ep_u_${(episodeSeq += 1)}`;
  db.prepare(`INSERT INTO episodes (id, state, created_by) VALUES (?, 'open', 'test')`).run(id);
  addEpisodeEvents(id, ids, "test");
}

/**
 * The user's shape: a big searchable-only archive behind a small Understand
 * window, and only part of that window actually read.
 */
function seedUsersShape(): { read: string[]; queued: string[]; archived: string[] } {
  const rows: EventEnvelope[] = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push(ev("browser", `201${i}-09-27T22:32:57.000Z`, `history ${i}`, "archive"));
  }
  for (let i = 0; i < 4; i += 1) {
    rows.push(ev("browser", `2026-09-0${i + 1}T10:00:00.000Z`, `in window ${i}`));
  }
  const r = appendEvents(rows, NOW);
  const archived = r.ids.slice(0, 8);
  const inWindow = r.ids.slice(8);
  const read = inWindow.slice(0, 2);
  // The rest went out to a pass that produced nothing — dispatched, unread.
  const queued = inWindow.slice(2);
  const mark = getDb().prepare(`UPDATE events SET dispatched_at = ? WHERE id = ?`);
  for (const id of inWindow) mark.run(new Date(NOW).toISOString(), id);
  understand(read);
  return { read, queued, archived };
}

describe("FIX-C5 — one definition of understood, shared by both surfaces", () => {
  it("freshness and the Storage panel report the same count, and it is the truth", () => {
    seedUsersShape();

    const f = sourceFreshness("browser", NOW, { hold: null });
    const s = sourceStorage("browser", null);
    const shared = understoodForSource("browser");

    // The truth: 2 of the 12 rows carry an episode.
    expect(shared.events).toBe(2);
    expect(f.understood_count).toBe(2);
    expect(s.understood.events).toBe(2);
    expect(f.understood_count).toBe(s.understood.events);

    // The two OLD numbers, both still available under their honest names —
    // 12 rows dispatched (8 of them archive rows the gate stamped), 4 inside
    // the Understand window.
    const dispatched = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE dispatched_at IS NOT NULL`)
      .get() as { n: number };
    expect(dispatched.n).toBe(12);
    expect(s.in_understand_window.events).toBe(4);
    expect(f.understand_window_count).toBe(4);
    expect(f.archive_count).toBe(8);
    expect(s.searchable.events).toBe(12);
  });

  it("the edges are the read events' edges, not the archive's", () => {
    seedUsersShape();
    const f = sourceFreshness("browser", NOW, { hold: null });
    expect(f.captured_from).toBe("2010-09-27T22:32:57.000Z");
    expect(f.understood_from).toBe("2026-09-01T10:00:00.000Z");
    expect(f.understood_to).toBe("2026-09-02T10:00:00.000Z");
    expect(f.label).toBe("Knows you: Sep 2026 → 4d ago");
    expect(sourceStorage("browser", null).understood.from).toBe("2026-09-01T10:00:00.000Z");
  });

  it("the understood bar is sized for the rows it names", () => {
    seedUsersShape();
    const s = sourceStorage("browser", null);
    expect(s.understood.bytes).toBeGreaterThan(0);
    // Two of the four in-window rows are read, so the understood bar is a
    // strict slice of the queue, which is itself a slice of what is kept.
    expect(s.understood.bytes).toBeLessThan(s.in_understand_window.bytes);
    expect(s.in_understand_window.bytes).toBeLessThan(s.searchable.bytes);
  });

  it("a source with nothing read reports zero on both surfaces, not a window size", () => {
    appendEvents([ev("whatsapp", "2026-09-05T10:00:00.000Z", "unread")], NOW);
    expect(understoodForSource("whatsapp").events).toBe(0);
    expect(sourceFreshness("whatsapp", NOW, { hold: null }).understood_count).toBe(0);
    expect(sourceStorage("whatsapp", null).understood.events).toBe(0);
    expect(sourceStorage("whatsapp", null).in_understand_window.events).toBe(1);
  });

  it("understoodBySource is the per-source read, source by source", () => {
    appendEvents([ev("whatsapp", "2026-09-05T10:00:00.000Z", "a")], NOW);
    seedUsersShape();
    const map = understoodBySource();
    expect(map.get("browser")?.events).toBe(2);
    expect(map.has("whatsapp")).toBe(false);
    expect(map.get("browser")).toEqual(understoodForSource("browser"));
  });
});
