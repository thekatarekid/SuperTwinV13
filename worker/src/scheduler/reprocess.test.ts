// ===========================================================================
// Two-pass enrichment completion (arch §8.4, §9.6; build item 3.5).
//
// The one number this file exists to hold: an episode carrying media is read
// EXACTLY TWICE. Not once (text would be wrong forever), not three times (pass
// 3 is where duplicate claims come from). A third read exists only for media
// that arrives later still, and it is bounded.
//
// Everything runs over a real SQLite DB with the real migrations, because the
// countdown, the counter and the queue row are all rows.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { resolveEnrichment } from "../media/enrich-pass.js";
import {
  armEnrichmentCountdown,
  clampReprocessMax,
  completionPassContext,
  DEFAULT_REPROCESS_MAX,
  dueCompletionPasses,
  getReprocessMax,
  lateMediaArrived,
  mediaStillReading,
  passState,
  placeholderFor,
  planCompletionPass,
  recordPassComplete,
  recordTextFirstPass,
  sessionsFlaggedForReconcile,
  setReprocessMax,
} from "./reprocess.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-reprocess-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO sources (id, type) VALUES ('whatsapp', 'whatsapp')`).run();
  db.prepare(
    `INSERT INTO streams (id, source_id, external_key, stream_kind) VALUES ('st1', 'whatsapp', 'pranjali', 'dm')`,
  ).run();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface SeedEvent {
  id: string;
  kind?: string;
  text?: string | null;
  descStatus?: string | null;
  description?: string | null;
  transcriptStatus?: string | null;
  transcript?: string | null;
  seconds?: number | null;
}

function seedEvent(e: SeedEvent, i: number): void {
  getDb()
    .prepare(
      `INSERT INTO events (id, source_id, stream_id, ts, kind, text, actor_id,
                           media_desc_status, media_description,
                           transcript_status, transcript, media_seconds)
       VALUES (@id, NULL, 'st1', @ts, @kind, @text, NULL,
               @descStatus, @description, @transcriptStatus, @transcript, @seconds)`,
    )
    .run({
      id: e.id,
      ts: `2026-07-02T10:0${i}:00.000Z`,
      kind: e.kind ?? "text",
      text: e.text ?? null,
      descStatus: e.descStatus ?? null,
      description: e.description ?? null,
      transcriptStatus: e.transcriptStatus ?? null,
      transcript: e.transcript ?? null,
      seconds: e.seconds ?? null,
    });
}

/** A sealed session over `events`, countdown NOT armed — arming is under test. */
function seedSession(id: string, events: SeedEvent[]): string {
  events.forEach(seedEvent);
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status)
       VALUES (@id, 'st1', 'whatsapp', '2026-07-02T10:00:00.000Z',
               '2026-07-02T10:30:00.000Z', @events, 'sealed')`,
    )
    .run({ id, events: JSON.stringify(events.map((e) => e.id)) });
  return id;
}

/** The whole normal life of one media episode, up to the end of pass 2. */
function runToCompletion(sessionId: string): void {
  recordTextFirstPass(sessionId);
  armEnrichmentCountdown(sessionId);
  const pending = getDb()
    .prepare(`SELECT event_ids AS ids FROM sessions WHERE id = ?`)
    .get(sessionId) as { ids: string };
  for (const id of JSON.parse(pending.ids) as string[]) resolveEnrichment(id, { text: "x" });
  markReadable(sessionId);
  armEnrichmentCountdown(sessionId);
  recordPassComplete(sessionId);
}

/** Whisper/vision came back: every attachment on the session now reads. */
function markReadable(sessionId: string): void {
  const row = getDb()
    .prepare(`SELECT event_ids AS ids FROM sessions WHERE id = ?`)
    .get(sessionId) as { ids: string };
  const db = getDb();
  for (const id of JSON.parse(row.ids) as string[]) {
    db.prepare(
      `UPDATE events
          SET media_desc_status  = CASE WHEN media_desc_status IS NULL THEN NULL ELSE 'done' END,
              media_description  = CASE WHEN media_desc_status IS NULL THEN NULL ELSE 'a whiteboard of dates' END,
              transcript_status  = CASE WHEN transcript_status IS NULL THEN NULL ELSE 'done' END,
              transcript         = CASE WHEN transcript_status IS NULL THEN NULL ELSE 'the villa is booked' END
        WHERE id = ?`,
    ).run(id);
  }
}

describe("arming the countdown (§8.4)", () => {
  it("counts only what is still being read — ready, failed and skipped are resolved", () => {
    const s = seedSession("s1", [
      { id: "e1", text: "look at this" },
      { id: "e2", kind: "image", descStatus: "pending" },
      { id: "e3", kind: "image", descStatus: "done", description: "a receipt for ₹840" },
      { id: "e4", kind: "voice", transcriptStatus: "error", seconds: 12 },
      { id: "e5", kind: "document", descStatus: "unsupported" },
    ]);
    expect(armEnrichmentCountdown(s)).toEqual({ sessionId: s, attachments: 4, pending: 1 });
    expect(passState(s)).toMatchObject({ attachments: 4, pending: 1, stillReading: true });

    const states = getDb()
      .prepare(`SELECT id, enrichment_state AS st FROM events ORDER BY id`)
      .all() as { id: string; st: string }[];
    expect(states).toEqual([
      { id: "e1", st: "none_needed" },
      { id: "e2", st: "pending" },
      { id: "e3", st: "ready" },
      { id: "e4", st: "failed" },
      { id: "e5", st: "skipped" },
    ]);
  });

  it("an attachment nothing has attempted yet is pending, not resolved", () => {
    const s = seedSession("s1", [{ id: "e1", kind: "image" }]);
    expect(armEnrichmentCountdown(s).pending).toBe(1);
    expect(mediaStillReading(s)).toBe(true);
  });

  it("a text-only episode arms nothing at all", () => {
    const s = seedSession("s1", [{ id: "e1", text: "hi" }, { id: "e2", text: "hello" }]);
    expect(armEnrichmentCountdown(s)).toEqual({ sessionId: s, attachments: 0, pending: 0 });
    expect(mediaStillReading(s)).toBe(false);
  });
});

describe("exactly two passes, never three (§8.4 rule 1)", () => {
  it("refuses the completion pass while any enrichment is still reading", () => {
    const s = seedSession("s1", [
      { id: "e1", text: "the dates" },
      { id: "e2", kind: "image", descStatus: "pending" },
    ]);
    recordTextFirstPass(s);
    armEnrichmentCountdown(s);
    const plan = planCompletionPass(s);
    expect(plan.run).toBe(false);
    expect(plan.refusal).toBe("enrichment_pending");
  });

  it("runs pass 2 once the last enrichment resolves, and refuses a third", () => {
    const s = seedSession("s1", [
      { id: "e1", text: "the dates" },
      { id: "e2", kind: "image", descStatus: "pending" },
      { id: "e3", kind: "voice", transcriptStatus: "pending", seconds: 30 },
    ]);
    recordTextFirstPass(s);
    armEnrichmentCountdown(s);
    expect(passState(s)).toMatchObject({ passesDone: 1, pending: 2 });

    markReadable(s);
    armEnrichmentCountdown(s);

    const second = planCompletionPass(s);
    expect(second).toMatchObject({ run: true, passNumber: 2, kind: "completion" });

    recordPassComplete(s);
    expect(passState(s)).toMatchObject({ passesDone: 2, pending: 0, stillReading: false });

    const third = planCompletionPass(s);
    expect(third.run).toBe(false);
    expect(third.refusal).toBe("already_complete");
  });

  it("an episode with no media has exactly one pass", () => {
    const s = seedSession("s1", [{ id: "e1", text: "just words" }]);
    recordTextFirstPass(s);
    armEnrichmentCountdown(s);
    const plan = planCompletionPass(s);
    expect(plan.run).toBe(false);
    expect(plan.refusal).toBe("text_only");
  });

  it("a failed transcription never strands the episode at ◍", () => {
    const s = seedSession("s1", [
      { id: "e1", kind: "voice", transcriptStatus: "pending", seconds: 40 },
    ]);
    recordTextFirstPass(s);
    armEnrichmentCountdown(s);
    getDb().prepare(`UPDATE events SET transcript_status = 'error' WHERE id = 'e1'`).run();
    armEnrichmentCountdown(s);
    expect(planCompletionPass(s)).toMatchObject({ run: true, passNumber: 2 });
  });

  it("recording pass 1 twice does not spend a pass", () => {
    const s = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "pending" }]);
    recordTextFirstPass(s);
    recordTextFirstPass(s);
    expect(passState(s)?.passesDone).toBe(1);
  });

  it("planning is a read — calling it twice cannot move the counter", () => {
    const s = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "done", description: "a map" }]);
    recordTextFirstPass(s);
    armEnrichmentCountdown(s);
    expect(planCompletionPass(s).run).toBe(true);
    expect(planCompletionPass(s).run).toBe(true);
    expect(passState(s)?.passesDone).toBe(1);
  });

  it("an unknown session is refused rather than guessed at", () => {
    expect(planCompletionPass("nope")).toMatchObject({ run: false, refusal: "unknown_session" });
    expect(passState("nope")).toBeNull();
    expect(completionPassContext("nope")).toBeNull();
  });
});

describe("late media — the bounded third pass (§8.4 rule 2, §9.6 rule 6)", () => {
  it("re-arms once, and the ceiling stops the fourth read", () => {
    const s = seedSession("s1", [
      { id: "e1", text: "the villa" },
      { id: "e2", kind: "image", descStatus: "pending" },
    ]);
    runToCompletion(s);
    expect(passState(s)?.passesDone).toBe(2);

    // A delayed sync brings a second attachment into the same episode.
    seedEvent({ id: "e3", kind: "image", descStatus: "pending" }, 5);
    getDb()
      .prepare(`UPDATE sessions SET event_ids = ? WHERE id = ?`)
      .run(JSON.stringify(["e1", "e2", "e3"]), s);

    const late = lateMediaArrived(s);
    expect(late).toMatchObject({ rearmed: true, pending: 1, nextPassNumber: 3 });
    expect(planCompletionPass(s).refusal).toBe("enrichment_pending");

    // The real path: the enrichment lane resolves the new attachment, the
    // countdown reaches zero and writes the completion row that buys pass 3.
    markReadable(s);
    expect(resolveEnrichment("e3", { text: "a whiteboard of dates" }).completionEnqueued).toBe(true);
    expect(planCompletionPass(s)).toMatchObject({ run: true, passNumber: 3, kind: "late_reprocess" });
    recordPassComplete(s);

    // Three passes spent. §9.6 rule 6: the data is kept, the PASS is what stops.
    const capped = planCompletionPass(s);
    expect(capped.run).toBe(false);
    expect(capped.refusal).toBe("reprocess_max");
    expect(capped.flaggedForReconcile).toBe(true);
    expect(sessionsFlaggedForReconcile()).toContain(s);
    expect(lateMediaArrived(s)).toMatchObject({ rearmed: false, flaggedForReconcile: true });
  });

  it("clears the spent queue row so the next completion can be enqueued", () => {
    const s = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "pending" }]);
    runToCompletion(s);
    const done = getDb()
      .prepare(`SELECT state FROM work_queue WHERE unit_id = ? AND stage = 'extract'`)
      .get(s) as { state: string };
    expect(done.state).toBe("done");

    seedEvent({ id: "e2", kind: "voice", transcriptStatus: "pending", seconds: 20 }, 6);
    getDb().prepare(`UPDATE sessions SET event_ids = ? WHERE id = ?`).run(JSON.stringify(["e1", "e2"]), s);
    expect(lateMediaArrived(s).rearmed).toBe(true);
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM work_queue WHERE unit_id = ?`).get(s),
    ).toEqual({ n: 0 });

    // The countdown reaching zero writes a fresh row, exactly as it did for pass 2.
    expect(resolveEnrichment("e2", { text: "the villa is booked" }).completionEnqueued).toBe(true);
  });

  it("a re-sync that changed nothing re-arms nothing (§9.6 rule 5)", () => {
    const s = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "pending" }]);
    runToCompletion(s);
    const late = lateMediaArrived(s);
    expect(late.rearmed).toBe(false);
    expect(late.pending).toBe(0);
    expect(planCompletionPass(s).refusal).toBe("already_complete");
  });

  it("late media on a session that does not exist is a no-op", () => {
    expect(lateMediaArrived("ghost")).toMatchObject({ rearmed: false, nextPassNumber: 0 });
  });
});

describe("the ceiling setting (§8.4 table)", () => {
  it("defaults to 3 and is clamped, never trusted raw", () => {
    expect(getReprocessMax()).toBe(DEFAULT_REPROCESS_MAX);
    expect(DEFAULT_REPROCESS_MAX).toBe(3);
    expect(clampReprocessMax(0)).toBe(2);
    expect(clampReprocessMax(99)).toBe(8);
    expect(clampReprocessMax(Number.NaN)).toBe(3);
    setReprocessMax(4);
    expect(getReprocessMax()).toBe(4);
  });

  it("a ceiling of 2 stops every episode at the completion pass", () => {
    setReprocessMax(2);
    const s = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "pending" }]);
    runToCompletion(s);
    const plan = planCompletionPass(s);
    expect(plan.refusal).toBe("reprocess_max");
    expect(plan.flaggedForReconcile).toBe(true);
  });
});

describe("the queue view", () => {
  it("hands out only the passes that may actually run, priority first", () => {
    const a = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "done", description: "a map" }]);
    const b = seedSession("s2", [{ id: "e9", kind: "image", descStatus: "pending" }]);
    for (const s of [a, b]) {
      recordTextFirstPass(s);
      armEnrichmentCountdown(s);
    }
    const db = getDb();
    db.prepare(
      `INSERT INTO work_queue (id, unit_kind, unit_id, stage, priority, state)
       VALUES ('w1', 'session', 's1', 'extract', 10, 'ready'),
              ('w2', 'session', 's2', 'extract', 90, 'ready')`,
    ).run();
    // s2 outranks s1 but is still reading, so only s1 is due.
    expect(dueCompletionPasses().map((d) => d.sessionId)).toEqual(["s1"]);

    // Zero duplicate claims from pass 2 starts here: once it has run, the
    // episode is never handed out for a second complete re-read.
    recordPassComplete("s1");
    expect(dueCompletionPasses()).toEqual([]);
  });
});

describe("what pass 2 carries (§8.4 delta context, §12.5)", () => {
  it("marks newly-readable attachments as the ► events and keeps the rest prior", () => {
    const s = seedSession("s1", [
      { id: "e1", text: "here are the dates" },
      { id: "e2", kind: "image", descStatus: "done", description: "a whiteboard of dates" },
      { id: "e3", kind: "voice", transcriptStatus: "pending", seconds: 30 },
    ]);
    const ctx = completionPassContext(s)!;
    expect(ctx.mode).toBe("summary");
    expect(ctx.newEvents.map((e) => e.id)).toEqual(["e2"]);
    expect(ctx.priorEvents.map((e) => e.id)).toEqual(["e1", "e3"]);
    expect(ctx.newEvents[0]!.text).toContain("a whiteboard of dates");
    // §9.6 rule 7: an unread attachment is UNKNOWN content, never absent.
    expect(ctx.priorEvents[1]!.text).toBe("[voice note, transcription pending]");
  });

  it("lists everything pass 1 extracted, so pass 2 never re-emits it", () => {
    const s = seedSession("s1", [
      { id: "e1", text: "the villa is ₹4,000" },
      { id: "e2", kind: "image", descStatus: "done", description: "a booking screenshot" },
    ]);
    const db = getDb();
    db.prepare(
      `INSERT INTO claim_versions (id, claim_key, kind, text, stated_at)
       VALUES ('c1', 'k1', 'fact', 'The villa costs ₹4,000 a night', '2026-07-02T10:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO loops (id, loop_key, intent, state) VALUES ('l1', 'lk1', 'Send the villa link', 'open')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence (subject_kind, subject_id, event_id, quote)
       VALUES ('claim', 'c1', 'e1', 'the villa is ₹4,000'),
              ('loop', 'l1', 'e1', 'the villa is ₹4,000')`,
    ).run();

    const ctx = completionPassContext(s)!;
    expect(ctx.extracted).toEqual([
      { alias: "H1", id: "c1", text: "The villa costs ₹4,000 a night" },
      { alias: "T1", id: "l1", text: "Send the villa link", note: "open" },
    ]);
    expect(ctx.itemIds).toEqual({ H1: "c1", T1: "l1" });
  });

  it("a claim closed by a supersession is not offered back as still-extracted", () => {
    const s = seedSession("s1", [{ id: "e1", kind: "image", descStatus: "done", description: "a map" }]);
    const db = getDb();
    db.prepare(
      `INSERT INTO claim_versions (id, claim_key, kind, text, stated_at, closed_by)
       VALUES ('c1', 'k1', 'fact', 'The villa costs ₹3,000', '2026-07-01T10:00:00.000Z', 'c2')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence (subject_kind, subject_id, event_id, quote) VALUES ('claim', 'c1', 'e1', 'a map')`,
    ).run();
    expect(completionPassContext(s)!.extracted).toEqual([]);
  });
});

describe("placeholders (§9.6 rule 7)", () => {
  it("says which kind and which lifecycle, never nothing", () => {
    expect(placeholderFor("pending", "image")).toBe("[image, description pending]");
    expect(placeholderFor("pending", "voice")).toBe("[voice note, transcription pending]");
    expect(placeholderFor("pending", "link")).toBe("[link, preview pending]");
    expect(placeholderFor("failed", "voice")).toBe("[voice note, unreadable]");
    expect(placeholderFor("skipped", "sticker")).toBe("[sticker, not read]");
  });
});
