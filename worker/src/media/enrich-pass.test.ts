// ===========================================================================
// The hand-off to pass 2 (arch §8.4, build item 1.4).
//
// The countdown, and the ONE work_queue row it produces. Ready, failed and
// skipped all resolve; landing on zero twice does not produce a third pass; and
// the salience gate is off by default, so everything triggers the pass.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { setEnrichmentSalienceGate } from "./batch.js";
import {
  enqueueCompletionPass,
  pendingEnrichmentCount,
  resolveEnrichment,
  salienceGateAdmits,
  sessionOfEvent,
  setPendingEnrichmentCount,
} from "./enrich-pass.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-enrich-pass-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A sealed session holding `eventIds`, with its countdown armed. */
function seedSession(id: string, eventIds: string[], pending = eventIds.length): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids,
                             status, pending_enrichment_count)
       VALUES (@id, NULL, 'whatsapp', '2026-07-02T10:00:00.000Z',
               '2026-07-02T10:30:00.000Z', @events, 'sealed', @pending)`,
    )
    .run({ id, events: JSON.stringify(eventIds), pending });
}

function queued(sessionId: string): { stage: string; priority: number }[] {
  return getDb()
    .prepare(
      `SELECT stage, priority FROM work_queue WHERE unit_kind = 'session' AND unit_id = ?`,
    )
    .all(sessionId) as { stage: string; priority: number }[];
}

describe("the countdown (§8.4)", () => {
  it("finds the session an attachment belongs to", () => {
    seedSession("s1", ["e1", "e2"]);
    expect(sessionOfEvent("e2")).toBe("s1");
    expect(sessionOfEvent("nobody")).toBeNull();
  });

  it("enqueues the completion pass exactly once, when the last attachment lands", () => {
    seedSession("s1", ["e1", "e2"]);

    const first = resolveEnrichment("e1", { text: "a whiteboard" });
    expect(first).toMatchObject({ sessionId: "s1", pending: 1, completionEnqueued: false });
    expect(queued("s1")).toHaveLength(0);

    const second = resolveEnrichment("e2", { text: "a receipt for ₹840" });
    expect(second).toMatchObject({ sessionId: "s1", pending: 0, completionEnqueued: true });
    expect(queued("s1")).toEqual([{ stage: "extract", priority: expect.any(Number) }]);
  });

  it("two passes, not N: a second landing on zero writes no second row", () => {
    seedSession("s1", ["e1"]);
    expect(resolveEnrichment("e1").completionEnqueued).toBe(true);
    expect(enqueueCompletionPass("s1")).toBe(false);
    expect(queued("s1")).toHaveLength(1);
  });

  it("a failed transcription resolves like a good one — it never strands the episode", () => {
    seedSession("s1", ["e1", "e2"]);
    // "[voice note, unreadable]": no text at all, still resolved (§8.4 rule 3).
    resolveEnrichment("e1", { text: null });
    expect(pendingEnrichmentCount("s1")).toBe(1);
    expect(resolveEnrichment("e2", { text: null }).completionEnqueued).toBe(true);
  });

  it("never counts below zero, however many verdicts arrive", () => {
    seedSession("s1", ["e1"], 1);
    resolveEnrichment("e1");
    resolveEnrichment("e1");
    expect(pendingEnrichmentCount("s1")).toBe(0);
  });

  it("an event no session claims resolves to nothing at all", () => {
    expect(resolveEnrichment("orphan")).toMatchObject({
      sessionId: null,
      completionEnqueued: false,
    });
  });

  it("arms the countdown for a session that is about to be enriched", () => {
    seedSession("s1", ["e1", "e2"], 0);
    setPendingEnrichmentCount("s1", 2);
    expect(pendingEnrichmentCount("s1")).toBe(2);
  });
});

describe("the salience gate (§8.4 table)", () => {
  it("is off by default — every enrichment triggers the pass", () => {
    expect(salienceGateAdmits("mm")).toBe(true);
    expect(salienceGateAdmits(null)).toBe(true);

    seedSession("s1", ["e1"]);
    expect(resolveEnrichment("e1", { text: "a blurry wall" })).toMatchObject({
      gated: false,
      completionEnqueued: true,
    });
  });

  it("on, it holds back a caption carrying no entity, date, number or commitment", () => {
    setEnrichmentSalienceGate(true);
    expect(salienceGateAdmits("a blurry wall")).toBe(false);
    expect(salienceGateAdmits("a receipt for 840")).toBe(true);
    expect(salienceGateAdmits("Pranjali at the door")).toBe(true);
    expect(salienceGateAdmits("please send it")).toBe(true);

    seedSession("s1", ["e1"]);
    expect(resolveEnrichment("e1", { text: "a blurry wall" })).toMatchObject({
      pending: 0,
      gated: true,
      completionEnqueued: false,
    });
    expect(queued("s1")).toHaveLength(0);
  });
});
