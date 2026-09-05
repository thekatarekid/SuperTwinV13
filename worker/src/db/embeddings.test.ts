// ===========================================================================
// Semantic-index storage (vitest). Two properties carry the design: a claim
// only ever returns what the ACTIVE model has not embedded yet (incremental),
// and a model change makes the old vectors invisible rather than comparable
// (no mixed spaces).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "./connection.js";
import {
  claimUnembeddedEvents,
  clearEventEmbeddings,
  countEmbeddableEvents,
  countEventEmbeddings,
  decodeVector,
  encodeVector,
  invalidateEventEmbedding,
  putEventEmbedding,
  putEventEmbeddings,
  readEventEmbeddings,
} from "./embeddings.js";
import {
  applyEdit,
  applyRevoke,
  insertEvent,
  recordMediaDescription,
  recordTranscript,
  upsertStream,
  upsertSource,
} from "./ingest.js";
import { deleteSourceData } from "../library/source-verbs.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-embeddings-test-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "supertwinv13.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const MINILM = { model: "all-MiniLM-L6-v2", dim: 4 };
const OTHER = { model: "bge-small-en", dim: 4 };

function vec(...values: number[]): Float32Array {
  return Float32Array.from(values);
}

interface SeedEvent {
  externalId: string;
  text?: string;
  kind?: string;
  minute?: number;
  mediaPath?: string;
  replyToExternalId?: string;
  replyToText?: string;
  linkUrl?: string;
}

function seed(events: SeedEvent[]): string {
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  const streamId = upsertStream({
    sourceId: "whatsapp",
    sourceExtId: "lunches@g.us",
    name: "Weekend lunches",
    kind: "group",
  });
  for (const [i, e] of events.entries()) {
    insertEvent({
      externalId: e.externalId,
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId,
      actorId: null,
      ts: `2026-08-01T12:${String(e.minute ?? i + 1).padStart(2, "0")}:00.000Z`,
      kind: e.kind ?? "message",
      text: e.text ?? "",
      mediaPath: e.mediaPath ?? null,
      rawJson: null,
      replyToExternalId: e.replyToExternalId ?? null,
      replyToText: e.replyToText ?? null,
      linkUrl: e.linkUrl ?? null,
    });
  }
  return streamId;
}

describe("claimUnembeddedEvents", () => {
  it("returns text-bearing events newest-first and nothing else", () => {
    seed([
      { externalId: "m1", text: "sunday lunch chalna hai kahin?" },
      { externalId: "m2", text: "booked oye kake", minute: 2 },
      { externalId: "empty", text: "", minute: 3 },
      { externalId: "react", text: "🎉", kind: "reaction", minute: 4 },
      {
        externalId: "quote",
        text: "wahan hi milte hai phir",
        replyToExternalId: "m1",
        replyToText: "sunday lunch chalna hai kahin?",
        minute: 5,
      },
    ]);

    const rows = claimUnembeddedEvents(10, MINILM);
    expect(rows.map((r) => r.id)).toEqual(["whatsapp:quote", "whatsapp:m2", "whatsapp:m1"]);
    // The quote rides along, so a reply carries the topic it has none of.
    expect(rows[0].replyToText).toBe("sunday lunch chalna hai kahin?");
    expect(countEmbeddableEvents()).toBe(3);
  });

  it("leaves out what is too short to mean anything on its own", () => {
    seed([
      { externalId: "long", text: "sunday lunch chalna hai kahin?" },
      { externalId: "ok", text: "haan theek", minute: 2 },
      { externalId: "emoji", text: "🙏", minute: 3 },
      // Its own words are two letters; the quote is not what this one said.
      {
        externalId: "bare",
        text: "ok",
        replyToExternalId: "long",
        replyToText: "sunday lunch chalna hai kahin?",
        minute: 4,
      },
    ]);

    expect(claimUnembeddedEvents(10, MINILM).map((r) => r.id)).toEqual(["whatsapp:long"]);
    expect(countEmbeddableEvents()).toBe(1);
  });

  it("stops returning a row once its vector is stored, and honours the limit", () => {
    seed([
      { externalId: "m1", text: "sunday lunch chalna hai kahin?" },
      { externalId: "m2", text: "booked oye kake", minute: 2 },
    ]);

    expect(claimUnembeddedEvents(1, MINILM).map((r) => r.id)).toEqual(["whatsapp:m2"]);
    putEventEmbedding({ eventId: "whatsapp:m2", ...MINILM, vector: vec(1, 0, 0, 0) });

    expect(claimUnembeddedEvents(10, MINILM).map((r) => r.id)).toEqual(["whatsapp:m1"]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(0, 1, 0, 0) });
    // Incremental: a turn that adds nothing embeds nothing.
    expect(claimUnembeddedEvents(10, MINILM)).toEqual([]);
    expect(countEventEmbeddings(MINILM)).toBe(2);
  });

  it("hands back everything again under a different model, one claim at a time", () => {
    seed([{ externalId: "m1", text: "booked oye kake" }]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });

    expect(claimUnembeddedEvents(10, MINILM)).toEqual([]);
    expect(claimUnembeddedEvents(10, OTHER).map((r) => r.id)).toEqual(["whatsapp:m1"]);
    // Same model, different dimension is a different space too.
    expect(
      claimUnembeddedEvents(10, { model: MINILM.model, dim: 8 }).map((r) => r.id),
    ).toEqual(["whatsapp:m1"]);
  });

  it("only surfaces a media row once it has words on it", () => {
    seed([{ externalId: "ptt", kind: "audio", mediaPath: "/media/wa/a.ogg" }]);
    expect(claimUnembeddedEvents(10, MINILM)).toEqual([]);

    recordTranscript("whatsapp:ptt", { transcript: "table booked", status: "done" });
    const rows = claimUnembeddedEvents(10, MINILM);
    expect(rows.map((r) => r.id)).toEqual(["whatsapp:ptt"]);
    expect(rows[0].transcript).toBe("table booked");
  });
});

describe("stored vectors", () => {
  it("round-trips a vector unchanged", () => {
    seed([{ externalId: "m1", text: "booked oye kake" }]);
    const vector = vec(0.5, -0.25, 0, 1.5);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector });

    const stored = readEventEmbeddings(MINILM);
    expect(stored).toHaveLength(1);
    expect(stored[0].eventId).toBe("whatsapp:m1");
    expect([...stored[0].vector]).toEqual([...vector]);
  });

  it("pins the byte layout so a stored index survives a restart", () => {
    // The blob is a file format: four little-endian float32s, not whatever the
    // CPU that wrote it happened to use.
    const blob = encodeVector(vec(1, -1, 0.5, 0));
    expect(blob.length).toBe(16);
    expect([...decodeVector(blob)]).toEqual([1, -1, 0.5, 0]);
  });

  it("reads back only the active space", () => {
    seed([
      { externalId: "m1", text: "booked oye kake" },
      { externalId: "m2", text: "sunday lunch", minute: 2 },
    ]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });
    putEventEmbedding({ eventId: "whatsapp:m2", ...OTHER, vector: vec(0, 1, 0, 0) });

    expect(readEventEmbeddings(MINILM).map((e) => e.eventId)).toEqual(["whatsapp:m1"]);
    expect(readEventEmbeddings(OTHER).map((e) => e.eventId)).toEqual(["whatsapp:m2"]);
  });

  it("replaces rather than accumulates when an event is re-embedded", () => {
    seed([{ externalId: "m1", text: "booked oye kake" }]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });
    putEventEmbedding({ eventId: "whatsapp:m1", ...OTHER, vector: vec(0, 0, 0, 1) });

    expect(readEventEmbeddings(MINILM)).toEqual([]);
    expect([...readEventEmbeddings(OTHER)[0].vector]).toEqual([0, 0, 0, 1]);
  });

  it("stores a batch in one call and rejects a wrong-sized vector", () => {
    seed([
      { externalId: "m1", text: "booked oye kake" },
      { externalId: "m2", text: "sunday lunch", minute: 2 },
    ]);
    expect(
      putEventEmbeddings([
        { eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) },
        { eventId: "whatsapp:m2", ...MINILM, vector: [0, 1, 0, 0] },
      ]),
    ).toBe(2);
    expect(countEventEmbeddings(MINILM)).toBe(2);

    // A truncated or padded vector is a permanently wrong answer that looks fine.
    expect(() =>
      putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0) }),
    ).toThrow(/2 dimensions, expected 4/);
  });

  it("goes when its event goes", () => {
    seed([{ externalId: "m1", text: "booked oye kake" }]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });

    deleteSourceData("whatsapp");
    expect(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM event_embeddings`).get() as {
        n: number;
      }).n,
    ).toBe(0);
  });

  it("clears on request, per model or entirely", () => {
    seed([
      { externalId: "m1", text: "booked oye kake" },
      { externalId: "m2", text: "sunday lunch", minute: 2 },
    ]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });
    putEventEmbedding({ eventId: "whatsapp:m2", ...OTHER, vector: vec(0, 1, 0, 0) });

    expect(clearEventEmbeddings({ model: OTHER.model })).toBe(1);
    expect(countEventEmbeddings(MINILM)).toBe(1);
    expect(clearEventEmbeddings()).toBe(1);
    expect(countEventEmbeddings(MINILM)).toBe(0);
  });
});

describe("invalidation on content change", () => {
  it("re-queues an event whose transcript arrives after it was embedded", () => {
    seed([{ externalId: "ptt", kind: "audio", mediaPath: "/media/wa/a.ogg", text: "voice note" }]);
    putEventEmbedding({ eventId: "whatsapp:ptt", ...MINILM, vector: vec(1, 0, 0, 0) });
    expect(claimUnembeddedEvents(10, MINILM)).toEqual([]);

    recordTranscript("whatsapp:ptt", { transcript: "table booked", status: "done" });
    expect(claimUnembeddedEvents(10, MINILM).map((r) => r.id)).toEqual(["whatsapp:ptt"]);
  });

  it("re-queues an event whose attachment description arrives late", () => {
    seed([{ externalId: "img", kind: "image", mediaPath: "/media/wa/a.jpg", text: "photo" }]);
    putEventEmbedding({ eventId: "whatsapp:img", ...MINILM, vector: vec(1, 0, 0, 0) });

    recordMediaDescription("whatsapp:img", {
      description: "a restaurant bill",
      status: "done",
    });
    expect(claimUnembeddedEvents(10, MINILM).map((r) => r.id)).toEqual(["whatsapp:img"]);
  });

  it("re-queues an edited message and drops a revoked one for good", () => {
    seed([
      { externalId: "m1", text: "sunday lunch chalna hai kahin?" },
      { externalId: "m2", text: "booked oye kake", minute: 2 },
    ]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });
    putEventEmbedding({ eventId: "whatsapp:m2", ...MINILM, vector: vec(0, 1, 0, 0) });

    applyEdit({
      sourceId: "whatsapp",
      targetExternalId: "m1",
      text: "saturday lunch chalna hai kahin?",
      editedAt: "2026-08-01T12:30:00.000Z",
    });
    applyRevoke({
      sourceId: "whatsapp",
      targetExternalId: "m2",
      revokedAt: "2026-08-01T12:31:00.000Z",
    });

    // The edit comes back to be re-embedded; the tombstone never does.
    expect(claimUnembeddedEvents(10, MINILM).map((r) => r.id)).toEqual(["whatsapp:m1"]);
    expect(countEventEmbeddings(MINILM)).toBe(0);
  });

  it("re-queues on request", () => {
    seed([{ externalId: "m1", text: "booked oye kake" }]);
    putEventEmbedding({ eventId: "whatsapp:m1", ...MINILM, vector: vec(1, 0, 0, 0) });

    invalidateEventEmbedding("whatsapp:m1");
    expect(claimUnembeddedEvents(10, MINILM).map((r) => r.id)).toEqual(["whatsapp:m1"]);
  });
});
