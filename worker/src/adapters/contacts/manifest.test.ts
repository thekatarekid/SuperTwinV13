// ===========================================================================
// The Contacts manifest (build item 5.2): valid under the SAME registration
// gate WhatsApp passes, registrable ALONGSIDE it — two manifests, one
// registry, zero generic-layer edits. That is the Phase-5 thesis in one file.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../../db/connection.js";
import { runMigrations } from "../../db/index.js";
import { WHATSAPP_MANIFEST } from "../whatsapp/manifest.js";
import {
  clearRegistry,
  gapMsFor,
  registeredSourceIds,
  registerSource,
  validateManifest,
  type SourceManifest,
} from "../registry.js";
import { ContactsAdapter } from "./adapter.js";
import { CONTACTS_MANIFEST, GAP_MS } from "./manifest.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-contacts-manifest-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  clearRegistry();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const asNever = <E,>(m: SourceManifest<E>) => m as unknown as SourceManifest<never>;

describe("CONTACTS_MANIFEST", () => {
  it("passes the registry's validation gate with zero problems", () => {
    expect(validateManifest(asNever(CONTACTS_MANIFEST))).toEqual([]);
  });

  it("is a document/single-actor source with participant_shift honestly off", () => {
    expect(CONTACTS_MANIFEST.stream_kind_of({ external_key: "addressbook", kind: "addressbook" })).toBe("document");
    expect(CONTACTS_MANIFEST.actor_model).toBe("single_actor");
    expect(CONTACTS_MANIFEST.segmentation.participant_shift).toBe(false);
  });

  it("emits only kinds the ladder can use, and bridges only on exact keys", () => {
    // phone + email are the ONLY kinds rung ② may join across sources.
    expect(CONTACTS_MANIFEST.identities_emitted).toEqual(["phone", "email", "account_id"]);
    expect(CONTACTS_MANIFEST.bridge_keys).toEqual(["phone", "email"]);
  });

  it("declares its self identity lazily — null before an import, no throw", () => {
    expect(CONTACTS_MANIFEST.self_identity.kind).toBe("email");
    expect(CONTACTS_MANIFEST.self_identity.value_getter()).toBeNull();
  });

  it("registers ALONGSIDE WhatsApp — the second source the registry has ever held", () => {
    const wa = registerSource; // same door, both sources
    wa(
      {
        manifest: asNever(WHATSAPP_MANIFEST),
        adapter: { sourceId: "whatsapp" } as never,
      },
      undefined,
    );
    registerSource({
      manifest: asNever(CONTACTS_MANIFEST),
      adapter: new ContactsAdapter({ vcardText: "" }) as never,
    });
    expect(registeredSourceIds()).toEqual(["contacts", "whatsapp"]);
  });

  it("answers the segmentation lookup with its own defaults", () => {
    expect(gapMsFor(asNever(CONTACTS_MANIFEST), "addressbook")).toBe(GAP_MS);
  });
});
