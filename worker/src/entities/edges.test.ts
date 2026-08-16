// ===========================================================================
// Entity edges (build item 1.5, arch §10.3; evals I).
//
// Under test: the closed subtype lists, "no evidence, no write", the metadata
// exemption that lets a participant list become an edge with no quote and no
// model, and the bitemporal-lite behaviour — a move or a contradiction CLOSES
// an edge and never deletes it.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import {
  METADATA_DECIDER,
  edgeEvidence,
  edgesFrom,
  edgesOf,
  listEdges,
  readEdge,
  rejectEdge,
  supersedeEdge,
  writeEdge,
} from "./edges.js";
import { createEntity } from "./registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ent-edges-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Ghar+", kind: "group" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function event(text: string, ts = "2026-08-14T09:10:00+05:30"): string {
  seq += 1;
  const streamId = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Ghar+", kind: "group" });
  const actorId = upsertActor({ sourceId: "whatsapp", sourceExtId: "a1", displayName: "a1" });
  return insertEvent({
    externalId: `c1/e${seq}`,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId,
    actorId,
    ts,
    kind: "message",
    text,
    mediaPath: null,
    rawJson: null,
    isHistorical: true,
  }).id;
}

describe("the closed edge vocabulary", () => {
  it("refuses a kind outside the seven and a subtype outside the kind's list", () => {
    const a = createEntity({ type: "person" });
    const b = createEntity({ type: "org" });
    expect(() =>
      writeEdge({ kind: "works_at" as never, srcEntityId: a.id, dstEntityId: b.id, decidedBy: METADATA_DECIDER }),
    ).toThrow(/not one of the 7 edge kinds/);
    expect(() =>
      writeEdge({
        kind: "affiliated_with",
        subtype: "sibling",
        srcEntityId: a.id,
        dstEntityId: b.id,
        decidedBy: METADATA_DECIDER,
      }),
    ).toThrow(/not a subtype of affiliated_with/);
  });

  it("refuses an edge from an entity to itself", () => {
    const a = createEntity({ type: "person" });
    expect(() =>
      writeEdge({ kind: "related_to", subtype: "sibling", srcEntityId: a.id, dstEntityId: a.id, decidedBy: METADATA_DECIDER }),
    ).toThrow(/to itself/);
  });
});

describe("evidence discipline", () => {
  it("a text edge with no quote is not written", () => {
    const a = createEntity({ type: "person" });
    const b = createEntity({ type: "person" });
    expect(() =>
      writeEdge({ kind: "related_to", subtype: "sibling", srcEntityId: a.id, dstEntityId: b.id, decidedBy: "llm:p-ep1" }),
    ).toThrow(/no evidence, no write/);
    expect(listEdges()).toHaveLength(0);
  });

  it("a text edge with a quote but no event is not written either", () => {
    const a = createEntity({ type: "person" });
    const b = createEntity({ type: "person" });
    expect(() =>
      writeEdge({
        kind: "related_to",
        subtype: "sibling",
        srcEntityId: a.id,
        dstEntityId: b.id,
        decidedBy: "llm:p-ep1",
        quote: "meri didi",
      }),
    ).toThrow(/quote with no event/);
  });

  it("keeps the quote verbatim against the event it came from", () => {
    const ev = event("meri didi is visiting");
    const me = createEntity({ type: "person", canonical: "me" });
    const didi = createEntity({ type: "person", canonical: "Rashmi" });
    const { edge } = writeEdge({
      kind: "related_to",
      subtype: "sibling",
      srcEntityId: me.id,
      dstEntityId: didi.id,
      confidence: 0.8,
      decidedBy: "llm:p-ep1",
      eventId: ev,
      quote: "meri didi",
    });
    expect(edgeEvidence(edge.id)).toEqual([{ edgeId: edge.id, eventId: ev, quote: "meri didi" }]);
  });

  it("exempts metadata edges — no quote, confidence 1.0", () => {
    const person = createEntity({ type: "person" });
    const group = createEntity({ type: "group", subtype: "family" });
    const { edge } = writeEdge({
      kind: "affiliated_with",
      subtype: "member",
      srcEntityId: person.id,
      dstEntityId: group.id,
      confidence: 1,
      decidedBy: METADATA_DECIDER,
    });
    expect(edge.confidence).toBe(1);
    expect(edge.decidedBy).toBe(METADATA_DECIDER);
    expect(edgeEvidence(edge.id)).toEqual([]);
  });
});

describe("bitemporal-lite", () => {
  it("a move closes the old current location and opens a new one", () => {
    const ev1 = event("we're in Koramangala now", "2026-01-04T09:00:00+05:30");
    const ev2 = event("shifting to Indiranagar next month", "2026-08-04T09:00:00+05:30");
    const rahul = createEntity({ type: "person", canonical: "Rahul" });
    const kora = createEntity({ type: "place", subtype: "area", canonical: "Koramangala" });
    const indira = createEntity({ type: "place", subtype: "area", canonical: "Indiranagar" });

    const first = writeEdge({
      kind: "located_at",
      subtype: "current",
      srcEntityId: rahul.id,
      dstEntityId: kora.id,
      confidence: 0.7,
      decidedBy: "llm:p-ep1",
      validFrom: "2026-01-04",
      eventId: ev1,
      quote: "we're in Koramangala now",
    });
    const second = writeEdge({
      kind: "located_at",
      subtype: "current",
      srcEntityId: rahul.id,
      dstEntityId: indira.id,
      confidence: 0.7,
      decidedBy: "llm:p-ep1",
      validFrom: "2026-09-01",
      eventId: ev2,
      quote: "shifting to Indiranagar next month",
    });

    expect(second.superseded.map((e) => e.id)).toEqual([first.edge.id]);
    const closed = readEdge(first.edge.id)!;
    expect(closed.status).toBe("superseded");
    expect(closed.validTo).toBe("2026-09-01");
    // Both survive. "Where did Rahul live in March" stays answerable.
    expect(edgesFrom(rahul.id, { kind: "located_at" })).toHaveLength(2);
    expect(edgesFrom(rahul.id, { kind: "located_at", status: "active" }).map((e) => e.dstEntityId)).toEqual([
      indira.id,
    ]);
  });

  it("a contradiction closes with its own quote and never deletes", () => {
    const ev1 = event("Prabhat cooks for us on weekdays");
    const ev2 = event("Prabhat stopped cooking last week");
    const me = createEntity({ type: "person", canonical: "me" });
    const prabhat = createEntity({ type: "person", canonical: "Prabhat" });
    const { edge } = writeEdge({
      kind: "related_to",
      subtype: "cook",
      srcEntityId: prabhat.id,
      dstEntityId: me.id,
      confidence: 0.8,
      decidedBy: "llm:p-ep1",
      eventId: ev1,
      quote: "Prabhat cooks for us on weekdays",
    });
    const after = supersedeEdge(edge.id, {
      validTo: "2026-08-10",
      eventId: ev2,
      quote: "Prabhat stopped cooking last week",
    });
    expect(after.status).toBe("superseded");
    expect(after.validTo).toBe("2026-08-10");
    expect(edgeEvidence(edge.id).map((e) => e.quote)).toEqual([
      "Prabhat cooks for us on weekdays",
      "Prabhat stopped cooking last week",
    ]);
    expect(listEdges()).toHaveLength(1);
  });

  it("a user rejection is a status, not a delete", () => {
    const ev = event("Amit from the gym");
    const a = createEntity({ type: "person" });
    const b = createEntity({ type: "person" });
    const { edge } = writeEdge({
      kind: "related_to",
      subtype: "friend",
      srcEntityId: a.id,
      dstEntityId: b.id,
      confidence: 0.6,
      decidedBy: "llm:p-ep1",
      eventId: ev,
      quote: "Amit from the gym",
    });
    expect(rejectEdge(edge.id).status).toBe("rejected");
    expect(listEdges()).toHaveLength(1);
    expect(edgesOf(a.id, { status: "active" })).toHaveLength(0);
  });
});

describe("idempotence", () => {
  it("a repeated edge raises confidence instead of duplicating", () => {
    const ev1 = event("bhabhi Keerti");
    const ev2 = event("Keerti, my bhabhi, called");
    const me = createEntity({ type: "person" });
    const keerti = createEntity({ type: "person" });
    const args = {
      kind: "related_to" as const,
      subtype: "in_law",
      srcEntityId: keerti.id,
      dstEntityId: me.id,
      decidedBy: "llm:p-ep1",
    };
    const first = writeEdge({ ...args, confidence: 0.6, eventId: ev1, quote: "bhabhi Keerti" });
    const second = writeEdge({ ...args, confidence: 0.9, eventId: ev2, quote: "Keerti, my bhabhi, called" });
    expect(second.created).toBe(false);
    expect(second.edge.id).toBe(first.edge.id);
    expect(second.edge.confidence).toBe(0.9);
    expect(edgeEvidence(first.edge.id)).toHaveLength(2);
    expect(listEdges()).toHaveLength(1);
  });
});
