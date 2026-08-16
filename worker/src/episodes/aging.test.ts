// ===========================================================================
// Episode aging (arch §11.1 rule 5, build item 2.1) — 14 days quiet, then
// closed/faded, and never a model call.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { upsertSource, upsertStream } from "../db/ingest.js";
import {
  EPISODE_CLOSED,
  EPISODE_FADED,
  EPISODE_QUIET_DAYS,
  EPISODE_QUIET_MS,
  ageEpisodes,
  fadeDecisions,
  isQuiet,
  quietMs,
  readOpenEpisodesForAging,
} from "./aging.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const DAY = 86_400_000;

let tmpDir: string;
/** Real stream rows: `episodes.stream_id` is a foreign key, not a label. */
let C1 = "";
let C2 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-aging-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "c1", kind: "dm" });
  C2 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c2", name: "c2", kind: "dm" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function episode(id: string, agoDays: number, arcState: string | null = "open"): void {
  getDb()
    .prepare(
      `INSERT INTO episodes (id, stream_id, topic_label, arc_state, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      C1,
      `topic ${id}`,
      arcState,
      new Date(NOW - agoDays * DAY - 3_600_000).toISOString(),
      new Date(NOW - agoDays * DAY).toISOString(),
    );
}

describe("the clock", () => {
  it("is 14 days, and the boundary day itself fades", () => {
    expect(EPISODE_QUIET_DAYS).toBe(14);
    expect(EPISODE_QUIET_MS).toBe(14 * DAY);
    expect(isQuiet(new Date(NOW - 14 * DAY).toISOString(), NOW)).toBe(true);
    expect(isQuiet(new Date(NOW - 13.99 * DAY).toISOString(), NOW)).toBe(false);
  });

  it("treats an unreadable last activity as unknown, never as silence", () => {
    expect(quietMs(null, NOW)).toBeNull();
    expect(quietMs("not a date", NOW)).toBeNull();
    expect(isQuiet(null, NOW)).toBe(false);
  });

  it("decides on values alone, sorted, with no database in sight", () => {
    const decisions = fadeDecisions(
      [
        { id: "b", arcState: "open", lastActiveAt: new Date(NOW - 20 * DAY).toISOString() },
        { id: "a", arcState: null, lastActiveAt: new Date(NOW - 15 * DAY).toISOString() },
        { id: "c", arcState: "open", lastActiveAt: new Date(NOW - 2 * DAY).toISOString() },
        { id: "d", arcState: "closed", lastActiveAt: new Date(NOW - 90 * DAY).toISOString() },
      ],
      NOW,
    );
    expect(decisions.map((d) => d.episodeId)).toEqual(["a", "b"]);
    expect(decisions[0]!.arcState).toBe(EPISODE_CLOSED);
    expect(decisions[0]!.outcome).toBe(EPISODE_FADED);
    expect(decisions[0]!.quietDays).toBe(15);
  });
});

describe("ageEpisodes", () => {
  it("closes 14, 15, 16 and 17 day silences and leaves 13 alone", () => {
    episode("e13", 13);
    episode("e14", 14);
    episode("e15", 15);
    episode("e16", 16);
    episode("e17", 17);

    const faded = ageEpisodes({ now: NOW });
    expect(faded.map((f) => f.episodeId)).toEqual(["e14", "e15", "e16", "e17"]);

    const rows = getDb()
      .prepare(`SELECT id, arc_state, outcome FROM episodes ORDER BY id`)
      .all() as { id: string; arc_state: string; outcome: string | null }[];
    expect(rows).toEqual([
      { id: "e13", arc_state: "open", outcome: null },
      { id: "e14", arc_state: "closed", outcome: "faded" },
      { id: "e15", arc_state: "closed", outcome: "faded" },
      { id: "e16", arc_state: "closed", outcome: "faded" },
      { id: "e17", arc_state: "closed", outcome: "faded" },
    ]);
  });

  it("is idempotent — a second run finds nothing left to close", () => {
    episode("e1", 30);
    expect(ageEpisodes({ now: NOW })).toHaveLength(1);
    expect(ageEpisodes({ now: NOW })).toHaveLength(0);
  });

  it("scopes to one stream when asked", () => {
    episode("e1", 30);
    getDb().prepare(`UPDATE episodes SET stream_id = ? WHERE id = 'e1'`).run(C2);
    episode("e2", 30);
    expect(ageEpisodes({ now: NOW, streamId: C1 }).map((f) => f.episodeId)).toEqual(["e2"]);
  });

  it("reads a state-less row as open, never as already closed", () => {
    episode("e1", 30, null);
    expect(readOpenEpisodesForAging().map((e) => e.id)).toEqual(["e1"]);
    expect(ageEpisodes({ now: NOW }).map((f) => f.episodeId)).toEqual(["e1"]);
  });
});
