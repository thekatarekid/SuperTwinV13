// ===========================================================================
// The V13 hand-off back to understanding (build P1.8, spec §4.4 rule 2).
//
// Pending counts per BUNDLE; zero → exactly one scoped re-understand job;
// placeholder→unsorted → the bundle re-dispatches fully. Ready, failed and
// skipped all resolve; landing on zero twice never produces a second job.
// TOP-05 (GoldenEvals V1) is asserted deterministically: a media-only message
// whose caption lands is re-understood with the caption in the pack line.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  ATTACHMENT_COLUMNS,
  stateOf,
  toPackEvent,
  type AttachmentRow,
} from "./enrichment-state.js";
import { setEnrichmentSalienceGate } from "./batch.js";
import {
  registerBundleForEnrichment,
  resolveEnrichment,
  salienceGateAdmits,
} from "./bundle-pass.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-bundle-pass-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  seedStream("wa:st:group1", "group1");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function seedStream(id: string, key: string, tier: string | null = "T1"): void {
  const db = getDb();
  db.prepare(`INSERT OR IGNORE INTO sources (id, type, name) VALUES ('wa', 'wa', 'wa')`).run();
  db.prepare(
    `INSERT OR IGNORE INTO streams (id, source_id, external_key, tier) VALUES (?, 'wa', ?, ?)`,
  ).run(id, key, tier);
}

interface SeedEvent {
  id: string;
  kind?: string;
  text?: string | null;
  ts?: string;
  dispatchedAt?: string | null;
  seconds?: number | null;
}

/** Insert events on wa:st:group1, dispatched (pass 1 already ran). */
function seedEvents(events: SeedEvent[]): void {
  const stmt = getDb().prepare(
    `INSERT INTO events (id, source_id, stream_id, stream_key, ts, kind, text,
                         media_seconds, origin, dispatched_at)
     VALUES (@id, 'wa', 'wa:st:group1', 'group1', @ts, @kind, @text, @seconds,
             'live', @dispatchedAt)`,
  );
  for (const e of events) {
    stmt.run({
      id: e.id,
      ts: e.ts ?? "2026-08-27T10:00:00.000Z",
      kind: e.kind ?? "text",
      text: e.text ?? null,
      seconds: e.seconds ?? null,
      dispatchedAt: e.dispatchedAt === undefined ? "2026-08-27T10:05:00.000Z" : e.dispatchedAt,
    });
  }
}

function bundleOf(ids: string[]): { streamId: string; events: { id: string }[] } {
  return { streamId: "wa:st:group1", events: ids.map((id) => ({ id })) };
}

function describeDone(id: string, caption: string): void {
  getDb()
    .prepare(
      `UPDATE events SET media_desc_status = 'done', media_description = ? WHERE id = ?`,
    )
    .run(caption, id);
}

function transcriptFailed(id: string): void {
  getDb()
    .prepare(`UPDATE events SET transcript_status = 'error' WHERE id = ?`)
    .run(id);
}

function understandJobs(): { id: string; unit_id: string; state: string }[] {
  return getDb()
    .prepare(
      `SELECT id, unit_id, state FROM work_queue
        WHERE stage = 'understand' AND unit_kind = 'bundle'`,
    )
    .all() as { id: string; unit_id: string; state: string }[];
}

function bundleRow(id: string): { pending_count: number; status: string } | undefined {
  return getDb()
    .prepare(`SELECT pending_count, status FROM enrichment_bundles WHERE id = ?`)
    .get(id) as { pending_count: number; status: string } | undefined;
}

function attachmentRow(id: string): AttachmentRow {
  return getDb()
    .prepare(`SELECT ${ATTACHMENT_COLUMNS} FROM events WHERE id = ?`)
    .get(id) as AttachmentRow;
}

/** Episode over the given events, optionally parked in unsorted. */
function seedEpisode(episodeId: string, eventIds: string[], opts: { unsorted?: boolean } = {}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO episodes (id, stream_id, state) VALUES (?, 'wa:st:group1', 'open')`,
  ).run(episodeId);
  const rowidOf = db.prepare(`SELECT rowid AS r FROM events WHERE id = ?`);
  const first = eventIds[0];
  const last = eventIds[eventIds.length - 1];
  db.prepare(
    `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    `ee-${episodeId}`,
    episodeId,
    first,
    last,
    (rowidOf.get(first) as { r: number }).r,
    (rowidOf.get(last) as { r: number }).r,
  );
  if (opts.unsorted) {
    db.prepare(
      `INSERT INTO unsorted (id, episode_id, reason, status)
       VALUES (?, ?, 'placeholder-only evidence', 'open')`,
    ).run(`un-${episodeId}`, episodeId);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerBundleForEnrichment", () => {
  it("records nothing for an all-text bundle — pass 1 saw every word", () => {
    seedEvents([
      { id: "e1", text: "flights are booked" },
      { id: "e2", text: "nice!" },
    ]);
    const reg = registerBundleForEnrichment(bundleOf(["e1", "e2"]));
    expect(reg).toEqual({ bundleId: null, pending: 0 });
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM enrichment_bundles`).get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it("counts pending attachments and is idempotent over re-registration", () => {
    seedEvents([
      { id: "e1", text: "look at these" },
      { id: "e2", kind: "image" },
      { id: "e3", kind: "voice", seconds: 12 },
    ]);
    const reg = registerBundleForEnrichment(bundleOf(["e1", "e2", "e3"]));
    expect(reg.pending).toBe(2);
    expect(reg.bundleId).not.toBeNull();
    // Same hand-off again: same deterministic id, still one row.
    const again = registerBundleForEnrichment(bundleOf(["e1", "e2", "e3"]));
    expect(again.bundleId).toBe(reg.bundleId);
    const rows = getDb().prepare(`SELECT COUNT(*) AS n FROM enrichment_bundles`).get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The countdown and the one re-understand job (enrichment-completion re-run)
// ---------------------------------------------------------------------------

describe("resolveEnrichment", () => {
  it("counts down per bundle and enqueues exactly ONE scoped re-understand at zero", () => {
    seedEvents([
      { id: "e1", text: "villa options below" },
      { id: "e2", kind: "image" },
      { id: "e3", kind: "voice", seconds: 12 },
    ]);
    seedEpisode("ep_412", ["e1", "e3"]);
    const { bundleId } = registerBundleForEnrichment(bundleOf(["e1", "e2", "e3"]));

    // First enrichment lands: still waiting on the voice note.
    describeDone("e2", "6BR villa, private pool, Anjuna");
    const first = resolveEnrichment("e2", { text: "6BR villa, private pool, Anjuna" });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ bundleId, pending: 1, action: "waiting" });
    expect(understandJobs()).toHaveLength(0);

    // FAILED counts as resolved — one dead voice note must not strand the
    // bundle. Zero → the one job, scoped to the affected episodes.
    transcriptFailed("e3");
    const second = resolveEnrichment("e3", { text: null });
    expect(second[0]).toMatchObject({ bundleId, pending: 0, action: "understand_enqueued" });
    expect(second[0].episodeIds).toEqual(["ep_412"]);

    const jobs = understandJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].unit_id).toBe(bundleId);
    expect(jobs[0].state).toBe("ready");
    expect(bundleRow(bundleId!)?.status).toBe("understood");

    // Landing on zero AGAIN — a re-settle of the same row — is a no-op: the
    // bundle is no longer waiting, and no second job appears.
    const rerun = resolveEnrichment("e3", { text: null });
    expect(rerun).toHaveLength(0);
    expect(understandJobs()).toHaveLength(1);

    // And a re-registration of the fully-resolved bundle records nothing new.
    const again = registerBundleForEnrichment(bundleOf(["e1", "e2", "e3"]));
    expect(again.bundleId).toBeNull();
    expect(understandJobs()).toHaveLength(1);
  });

  it("resolves an event to nothing when no bundle is waiting on it", () => {
    seedEvents([{ id: "e9", kind: "image" }]);
    describeDone("e9", "a receipt");
    expect(resolveEnrichment("e9", { text: "a receipt" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Placeholder → unsorted re-dispatch (spec §4.4 rule 2, last clause)
// ---------------------------------------------------------------------------

describe("placeholder-forced unsorted", () => {
  it("re-dispatches the bundle fully instead of a scoped re-understand", () => {
    seedEvents([
      { id: "e1", kind: "image" },
      { id: "e2", text: "?" },
    ]);
    seedEpisode("ep_x", ["e1", "e2"], { unsorted: true });
    // The dispatcher's cursor sits past the bundle.
    const db = getDb();
    const maxRowid = (db.prepare(`SELECT MAX(rowid) AS r FROM events`).get() as { r: number }).r;
    db.prepare(`UPDATE streams SET cursor_rowid = ? WHERE id = 'wa:st:group1'`).run(maxRowid);

    const { bundleId } = registerBundleForEnrichment(bundleOf(["e1", "e2"]));
    describeDone("e1", "6BR villa, private pool, Anjuna");
    const res = resolveEnrichment("e1", { text: "6BR villa, private pool, Anjuna" });
    expect(res[0]).toMatchObject({ bundleId, action: "redispatched" });
    expect(res[0].episodeIds).toEqual(["ep_x"]);

    // No scoped job — the whole bundle goes around again.
    expect(understandJobs()).toHaveLength(0);
    expect(bundleRow(bundleId!)?.status).toBe("redispatched");

    // Processed marks cleared and the cursor pulled back: the next dispatch
    // window rebuilds the bundle, this time with the caption in the events.
    const marks = db
      .prepare(`SELECT id, dispatched_at FROM events WHERE id IN ('e1','e2') ORDER BY id`)
      .all() as { id: string; dispatched_at: string | null }[];
    expect(marks.every((m) => m.dispatched_at === null)).toBe(true);
    const cursor = (
      db.prepare(`SELECT cursor_rowid AS c FROM streams WHERE id = 'wa:st:group1'`).get() as { c: number }
    ).c;
    const minRowid = (
      db.prepare(`SELECT MIN(rowid) AS r FROM events WHERE id IN ('e1','e2')`).get() as { r: number }
    ).r;
    expect(cursor).toBe(minRowid - 1);

    // Reversible: the mutation left a decisions row with the restore payload.
    const dec = db
      .prepare(
        `SELECT action, old_json FROM decisions WHERE target_kind = 'bundle' AND target_id = ?`,
      )
      .get(bundleId) as { action: string; old_json: string };
    expect(dec.action).toBe("redispatch");
    expect(JSON.parse(dec.old_json).dispatched).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// TOP-05 (deterministic): media-only message carries the topic
// ---------------------------------------------------------------------------

describe("TOP-05 — media-only message carries the topic", () => {
  it("placeholder before, caption in the pack line after, re-understand scoped to ep_412", () => {
    // ep_412 open; Rohan sends the villa photo + "this one?".
    seedEvents([
      { id: "m1", text: "budget is 6k/night", ts: "2026-08-27T09:58:00.000Z" },
      { id: "m2", kind: "image", text: "this one?", ts: "2026-08-27T10:00:00.000Z" },
    ]);
    seedEpisode("ep_412", ["m1", "m2"]);

    // Pass 1 saw an EXPLICIT placeholder, never absent content (§9.6 rule 7).
    const before = attachmentRow("m2");
    expect(stateOf(before)).toBe("pending");
    expect(toPackEvent(before, stateOf(before), "wa:st:group1").text).toBe(
      "this one? [image, description pending]",
    );

    const { bundleId } = registerBundleForEnrichment(bundleOf(["m1", "m2"]));
    expect(bundleId).not.toBeNull();

    // Enrichment done: the caption exists.
    describeDone("m2", "6BR villa, private pool, Anjuna");
    const res = resolveEnrichment("m2", { text: "6BR villa, private pool, Anjuna" });
    expect(res[0].action).toBe("understand_enqueued");
    expect(res[0].episodeIds).toEqual(["ep_412"]); // joined to ep_412, not skipped

    // enrichment_usage: what the re-understand reads carries the caption —
    // the media message is not a blind spot because its text is short.
    const after = attachmentRow("m2");
    expect(stateOf(after)).toBe("ready");
    expect(toPackEvent(after, stateOf(after), "wa:st:group1").text).toBe(
      "this one? [image: 6BR villa, private pool, Anjuna]",
    );

    // Exactly one job, keyed to this bundle.
    const jobs = understandJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].unit_id).toBe(bundleId);
  });
});

// ---------------------------------------------------------------------------
// Salience gate (§8.4 table) — off by default
// ---------------------------------------------------------------------------

describe("salience gate", () => {
  afterEach(() => {
    setEnrichmentSalienceGate(false);
  });

  it("admits everything while off, and only material text while on", () => {
    expect(salienceGateAdmits(null)).toBe(true);
    setEnrichmentSalienceGate(true);
    expect(salienceGateAdmits("👍👍")).toBe(false);
    expect(salienceGateAdmits("₹5,200 for the villa")).toBe(true);
  });

  it("holds a non-material zero back, then a material resolution completes", () => {
    seedEvents([{ id: "g1", kind: "image" }]);
    const { bundleId } = registerBundleForEnrichment(bundleOf(["g1"]));
    setEnrichmentSalienceGate(true);

    describeDone("g1", "thumbs up emoji");
    const gatedRes = resolveEnrichment("g1", { text: "👍👍" });
    expect(gatedRes[0]).toMatchObject({ bundleId, pending: 0, action: "gated" });
    expect(understandJobs()).toHaveLength(0);

    // Still waiting; the next material resolution of the same bundle completes.
    const done = resolveEnrichment("g1", { text: "Anjuna villa listing" });
    expect(done[0].action).toBe("understand_enqueued");
    expect(understandJobs()).toHaveLength(1);
  });
});
