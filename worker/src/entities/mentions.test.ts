// ===========================================================================
// Mentions — the entity ↔ event link the graph walks (V6 P1 S2.6).
// One row per (event, entity); repeats raise confidence; aliases resolve.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent } from "../db/eventlog.js";
import { mentionsOfEntity, mentionsOfEvent, writeMention } from "./mentions.js";
import { createEntity } from "./registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-mentions-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function event(text: string, ts = "2026-09-06T12:00:00.000Z"): string {
  return appendEvent({
    ts,
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: "ma@s.whatsapp.net",
    actor: "contact:ma",
    roles: { sender: "contact:ma", audience: ["self"], receiver: ["*audience"], mentions: [] },
    payload: { text },
  }).id;
}

describe("writeMention", () => {
  it("writes one row per (event, entity) and only ever raises confidence", () => {
    const ma = createEntity({ type: "person", canonical: "Ma" }).id;
    const e = event("Ma: chai?");
    const first = writeMention({ eventId: e, entityId: ma, surfaceText: "Ma", confidence: 0.7, decidedBy: "test" });
    expect(first).toMatchObject({ eventId: e, entityId: ma, confidence: 0.7, surfaceText: "Ma" });
    const again = writeMention({ eventId: e, entityId: ma, confidence: 0.4, decidedBy: "test" });
    expect(again!.id).toBe(first!.id);
    expect(again!.confidence).toBe(0.7);
    const higher = writeMention({ eventId: e, entityId: ma, confidence: 0.95, decidedBy: "test" });
    expect(higher!.confidence).toBe(0.95);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM mentions`).get()).toEqual({ n: 1 });
  });

  it("resolves a merged alias to the surviving entity; unknown entity or event writes nothing", () => {
    const ma = createEntity({ type: "person", canonical: "Ma" }).id;
    const alias = createEntity({ type: "person", canonical: "Mummy" }).id;
    getDb().prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(ma, alias);
    const e = event("Mummy called");
    expect(writeMention({ eventId: e, entityId: alias, decidedBy: "test" })!.entityId).toBe(ma);
    expect(writeMention({ eventId: e, entityId: "ent_missing", decidedBy: "test" })).toBeNull();
    expect(writeMention({ eventId: "ev_missing", entityId: ma, decidedBy: "test" })).toBeNull();
    expect(() => writeMention({ eventId: e, entityId: ma, decidedBy: "" })).toThrow(/decidedBy/);
  });

  it("reads by event and by entity (newest first, capped)", () => {
    const ma = createEntity({ type: "person", canonical: "Ma" }).id;
    const papa = createEntity({ type: "person", canonical: "Papa" }).id;
    const e1 = event("Ma and Papa", "2026-09-01T00:00:00Z");
    const e2 = event("Ma again", "2026-09-05T00:00:00Z");
    writeMention({ eventId: e1, entityId: ma, decidedBy: "test" });
    writeMention({ eventId: e1, entityId: papa, decidedBy: "test" });
    writeMention({ eventId: e2, entityId: ma, decidedBy: "test" });
    expect(mentionsOfEvent(e1).map((m) => m.entityId).sort()).toEqual([ma, papa].sort());
    expect(mentionsOfEntity(ma).map((m) => m.eventId)).toEqual([e2, e1]);
    expect(mentionsOfEntity(ma, 1).map((m) => m.eventId)).toEqual([e2]);
  });
});
