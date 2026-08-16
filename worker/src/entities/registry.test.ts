// ===========================================================================
// The closed vocabulary and the entity row (build item 1.5, arch §10.3).
//
// Three things are worth a test here, and they are all about what CANNOT be
// stored: a tenth type, a subtype from the wrong type's list, and an id with a
// name inside it. The fourth is the merge redirect, which every read in the
// system leans on.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  EDGE_KINDS,
  EDGE_SUBTYPES,
  ENTITY_SUBTYPES,
  ENTITY_TYPES,
  confirmEntity,
  countEntities,
  createEntity,
  getEntity,
  isEdgeKind,
  isEdgeSubtype,
  isEntitySubtype,
  isEntityType,
  listEntities,
  mergedAliasIds,
  mintEntityId,
  pinEntity,
  readEntityRaw,
  renameEntity,
  resolveEntityId,
  setEntityType,
  touchEntity,
} from "./registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ent-registry-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("the closed sets", () => {
  it("has exactly 9 types and 7 edge kinds", () => {
    expect(ENTITY_TYPES).toHaveLength(9);
    expect(EDGE_KINDS).toHaveLength(7);
    expect([...ENTITY_TYPES]).toEqual([
      "person",
      "group",
      "org",
      "place",
      "thing",
      "media_work",
      "document",
      "occasion",
      "topic",
    ]);
    expect([...EDGE_KINDS]).toEqual([
      "related_to",
      "affiliated_with",
      "has",
      "located_at",
      "part_of",
      "participates_in",
      "about",
    ]);
  });

  it("rejects anything outside the sets", () => {
    expect(isEntityType("product")).toBe(false);
    expect(isEntityType("service")).toBe(false);
    expect(isEntityType("app_site")).toBe(false);
    expect(isEdgeKind("works_at")).toBe(false);
    expect(isEdgeKind("pet_of")).toBe(false);
  });

  it("keeps the folded types alive as `thing` subtypes", () => {
    for (const flavour of ["product", "service", "vehicle", "account", "pet", "health_item", "food_item"]) {
      expect(ENTITY_SUBTYPES.thing).toContain(flavour);
    }
  });

  it("never lets a relationship become a type", () => {
    // "doctor" is a relation between two people, not a kind of thing.
    for (const type of ENTITY_TYPES) expect(ENTITY_SUBTYPES[type]).not.toContain("doctor");
    expect(EDGE_SUBTYPES.related_to).toContain("doctor");
  });

  it("scopes subtypes to their own type and kind", () => {
    expect(isEntitySubtype("place", "restaurant")).toBe(true);
    expect(isEntitySubtype("org", "restaurant")).toBe(false);
    expect(isEntitySubtype("person", null)).toBe(true);
    expect(isEntitySubtype("person", "father")).toBe(false);
    expect(isEdgeSubtype("has", "owns")).toBe(true);
    expect(isEdgeSubtype("affiliated_with", "owns")).toBe(false);
    expect(isEdgeSubtype("part_of", null)).toBe(true);
    expect(isEdgeSubtype("part_of", "member")).toBe(false);
  });
});

describe("minted ids", () => {
  it("is never derived from anything about the entity", () => {
    const a = createEntity({ type: "person", canonical: "Pranjali Sachdeva" });
    const b = createEntity({ type: "person", canonical: "Pranjali Sachdeva" });
    expect(a.id).not.toEqual(b.id);
    expect(a.id.toLowerCase()).not.toContain("pranjali");
    expect(a.id).toMatch(/^ent_[0-9a-f]{24}$/);
  });

  it("does not repeat over many mints", () => {
    const seen = new Set(Array.from({ length: 500 }, () => mintEntityId()));
    expect(seen.size).toBe(500);
  });
});

describe("rows", () => {
  it("refuses a type outside the nine and a subtype outside the list", () => {
    expect(() => createEntity({ type: "product" as never })).toThrow(/not one of the 9 types/);
    expect(() => createEntity({ type: "org", subtype: "city" })).toThrow(/not a subtype of org/);
  });

  it("mints provisional by default and confirms on a second touch", () => {
    const e = createEntity({ type: "person", canonical: "the broker" });
    expect(e.provisional).toBe(true);
    confirmEntity(e.id);
    expect(getEntity(e.id)?.provisional).toBe(false);
  });

  it("pinning takes an entity out of provisional", () => {
    const e = createEntity({ type: "topic", canonical: "local LLMs" });
    pinEntity(e.id);
    const after = getEntity(e.id)!;
    expect(after.userPinned).toBe(true);
    expect(after.provisional).toBe(false);
  });

  it("widens the seen window and never narrows it", () => {
    const e = createEntity({ type: "person", seenAt: "2026-08-10T00:00:00Z" });
    touchEntity(e.id, "2026-08-14T00:00:00Z");
    touchEntity(e.id, "2026-08-01T00:00:00Z");
    const after = getEntity(e.id)!;
    expect(after.firstSeenAt).toBe("2026-08-01T00:00:00Z");
    expect(after.lastSeenAt).toBe("2026-08-14T00:00:00Z");
  });

  it("renames and retypes without changing the id", () => {
    const e = createEntity({ type: "topic", canonical: "bhangra" });
    renameEntity(e.id, "bhangra classes");
    setEntityType(e.id, "occasion", "party");
    const after = getEntity(e.id)!;
    expect(after.id).toBe(e.id);
    expect(after.canonical).toBe("bhangra classes");
    expect(after.type).toBe("occasion");
    expect(after.subtype).toBe("party");
  });
});

describe("the merge redirect", () => {
  it("resolves a tombstone to the survivor and lists both as aliases", () => {
    const winner = createEntity({ type: "person", canonical: "Papa" });
    const loser = createEntity({ type: "person", canonical: "Papa (Jio)" });
    // Written directly: `merge.ts` owns the policy, this is the read path only.
    getDb().prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(winner.id, loser.id);

    expect(resolveEntityId(loser.id)).toBe(winner.id);
    expect(getEntity(loser.id)?.id).toBe(winner.id);
    expect(readEntityRaw(loser.id)?.mergedInto).toBe(winner.id);
    expect(mergedAliasIds(winner.id).sort()).toEqual([winner.id, loser.id].sort());
    // A tombstone is not a second entity.
    expect(listEntities().map((e) => e.id)).toEqual([winner.id]);
    expect(countEntities()).toBe(1);
  });

  it("refuses to walk a cyclic chain forever", () => {
    const a = createEntity({ type: "person" });
    const b = createEntity({ type: "person" });
    getDb().prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(b.id, a.id);
    getDb().prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(a.id, b.id);
    expect(() => resolveEntityId(a.id)).toThrow(/did not terminate/);
  });
});
