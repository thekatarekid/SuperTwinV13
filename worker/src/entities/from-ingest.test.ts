// ===========================================================================
// Entities from ingest (build P1.1, spec §7.2 rung 1 / §7.3.1): announced
// actors become provisional person entities bound by jid + encoded phone,
// idempotently; self is never provisional; group jids become group entities;
// a display name learned later fills a missing canonical, never overwrites.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../db/connection.js";
import { ensureEntityForActor } from "./from-ingest.js";
import { findIdentity, identitiesOf } from "./identities.js";
import { getEntity } from "./registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-entities-ingest-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const ROHAN = { sourceId: "wa", jid: "919876543210@s.whatsapp.net", displayName: "Rohan Mehta" };

describe("ensureEntityForActor", () => {
  it("mints a provisional person with jid + cross-source phone identities", () => {
    const id = ensureEntityForActor(ROHAN)!;
    const entity = getEntity(id)!;
    expect(entity.type).toBe("person");
    expect(entity.canonical).toBe("Rohan Mehta");
    expect(entity.provisional).toBe(true);

    const ids = identitiesOf(id);
    expect(ids.map((i) => i.kind).sort()).toEqual(["jid", "phone"]);
    // Phone is filed source-less so a future source joins on it.
    const phone = ids.find((i) => i.kind === "phone")!;
    expect(phone.sourceId).toBeNull();
    expect(phone.valueNorm).toBe("+919876543210");
  });

  it("is idempotent: the same jid lands on the same entity every time", () => {
    const first = ensureEntityForActor(ROHAN);
    const second = ensureEntityForActor(ROHAN);
    expect(second).toBe(first);
    expect(identitiesOf(first!).filter((i) => i.kind === "jid")).toHaveLength(1);
  });

  it("self is never a provisional person", () => {
    const id = ensureEntityForActor({ sourceId: "wa", jid: "911111111111@s.whatsapp.net", isSelf: true })!;
    expect(getEntity(id)!.provisional).toBe(false);
    // No source-less phone for self either — "me" needs no cross-source merge bait.
    expect(identitiesOf(id).map((i) => i.kind)).toEqual(["jid"]);
  });

  it("a group jid becomes a group entity, not a person", () => {
    const id = ensureEntityForActor({ sourceId: "wa", jid: "1602555@g.us", displayName: "Goa gang" })!;
    const entity = getEntity(id)!;
    expect(entity.type).toBe("group");
    expect(entity.canonical).toBe("Goa gang");
    expect(identitiesOf(id).map((i) => i.kind)).toEqual(["jid"]);
  });

  it("fills a missing canonical from a later sighting, never overwrites one", () => {
    const anon = ensureEntityForActor({ sourceId: "wa", jid: "919000000001@s.whatsapp.net" })!;
    expect(getEntity(anon)!.canonical).toBeNull();
    ensureEntityForActor({ sourceId: "wa", jid: "919000000001@s.whatsapp.net", displayName: "Tanvi S" });
    expect(getEntity(anon)!.canonical).toBe("Tanvi S");
    ensureEntityForActor({ sourceId: "wa", jid: "919000000001@s.whatsapp.net", displayName: "T 🌸" });
    expect(getEntity(anon)!.canonical).toBe("Tanvi S");
  });

  it("returns null for an empty jid; the identity is findable by raw value", () => {
    expect(ensureEntityForActor({ sourceId: "wa", jid: "  " })).toBeNull();
    ensureEntityForActor(ROHAN);
    expect(findIdentity("wa", "jid", ROHAN.jid)).not.toBeNull();
  });
});
