// ===========================================================================
// Claims store (build P1.1, spec §8.3): append-only versions on the kept V11
// design · active = derived (a late old version cannot dislodge truth) ·
// contradictions coexist until closed, closes never delete · header rows kept
// in the same tx · party_pair derived by code · evidence required · space
// refs · tone profiles (generic address terms feed tone, never identity).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { decisionsFor } from "../db/decisions.js";
import { createEntity } from "../entities/registry.js";
import {
  activeClaim,
  claimHistory,
  claimsAbout,
  claimsInSpace,
  closeClaimVersion,
  getToneProfile,
  isClaimKind,
  linkClaimToSpace,
  upsertToneProfile,
  writeClaimVersion,
  type WriteClaimParams,
} from "./store.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-claims-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function base(overrides: Partial<WriteClaimParams> = {}): WriteClaimParams {
  return {
    claimKey: "rohan.preference.coffee",
    kind: "preference",
    subjectId: null,
    subjectHint: "Rohan",
    text: "Rohan prefers filter coffee",
    confidence: 0.85,
    statedAt: "2026-08-01T10:00:00Z",
    evidence: [{ event_ids: ["e1"], quote: "filter coffee only please" }],
    decidedBy: "llm:extract",
    ...overrides,
  };
}

describe("versions + derived active", () => {
  it("writes a version, maintains the header, records a decision", () => {
    const v = writeClaimVersion(base());
    expect(v.id).toMatch(/^clv_/);
    expect(v.evidence[0]!.quote).toBe("filter coffee only please");

    const active = activeClaim("rohan.preference.coffee");
    expect(active?.id).toBe(v.id);

    const header = getDb().prepare(`SELECT * FROM claims WHERE claim_key = ?`).get("rohan.preference.coffee") as
      | Record<string, unknown>
      | undefined;
    expect(header?.status).toBe("active");
    expect(header?.active_version_id).toBe(v.id);
    expect(header?.version_count).toBe(1);

    const decisions = decisionsFor("claim", "rohan.preference.coffee");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.action).toBe("create_version");
  });

  it("stated_at is the ONLY precedence: a late-arriving OLDER version cannot dislodge", () => {
    const newer = writeClaimVersion(base({ statedAt: "2026-08-20T10:00:00Z", text: "prefers espresso now" }));
    writeClaimVersion(base({ statedAt: "2026-07-01T10:00:00Z", text: "prefers filter coffee" }));
    const active = activeClaim("rohan.preference.coffee");
    expect(active?.id).toBe(newer.id);
    expect(active?.text).toBe("prefers espresso now");
    expect(claimHistory("rohan.preference.coffee")).toHaveLength(2);
  });

  it("contradictions coexist until closed; closing ends validity, never deletes", () => {
    const old = writeClaimVersion(base({ statedAt: "2026-08-01T10:00:00Z" }));
    writeClaimVersion(
      base({
        statedAt: "2026-08-10T10:00:00Z",
        text: "Rohan quit coffee",
        relation: "contradicts",
        relatedVersionId: old.id,
      }),
    );
    // Both stored; the newer stated wins the active slot, the old row remains.
    expect(claimHistory("rohan.preference.coffee")).toHaveLength(2);

    const closed = closeClaimVersion(old.id, { closedBy: "llm:judge", reason: "superseded" });
    expect(closed.closedBy).toBe("llm:judge");
    expect(activeClaim("rohan.preference.coffee")?.text).toBe("Rohan quit coffee");
    // Still two rows — closes never delete.
    expect(claimHistory("rohan.preference.coffee")).toHaveLength(2);
  });

  it("no evidence, no write; unknown kinds rejected", () => {
    expect(() => writeClaimVersion(base({ evidence: [] }))).toThrow(/no evidence/);
    expect(() => writeClaimVersion(base({ evidence: [{ event_ids: [], quote: "  " }] }))).toThrow(/no evidence/);
    expect(() => writeClaimVersion(base({ kind: "vibe" as never }))).toThrow(/not a claim kind/);
    expect(isClaimKind("habit")).toBe(true);
    expect(isClaimKind("vibe")).toBe(false);
  });

  it("derives party_pair by code from the session, never from the model", () => {
    const self = createEntity({ type: "person", canonical: "Aditya", provisional: false });
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    const v = writeClaimVersion(
      base({
        subjectId: rohan.id,
        speakerId: self.id,
        session: { selfEntityId: self.id, participantEntityIds: [rohan.id] },
      }),
    );
    expect(v.partyPair).toBe("so");
    // Unresolved subject → no pair, never an invented one.
    const v2 = writeClaimVersion(
      base({ claimKey: "k2", subjectId: null, speakerId: self.id, session: { selfEntityId: self.id } }),
    );
    expect(v2.partyPair).toBeNull();
  });

  it("claimsAbout reads the active set for a subject", () => {
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    writeClaimVersion(base({ claimKey: "a", subjectId: rohan.id }));
    writeClaimVersion(base({ claimKey: "b", subjectId: rohan.id, kind: "habit", statedAt: "2026-08-02T10:00:00Z" }));
    expect(claimsAbout(rohan.id)).toHaveLength(2);
    expect(claimsAbout(rohan.id, "habit")).toHaveLength(1);
  });
});

describe("space refs (claims live globally; spaces hold refs)", () => {
  it("links and reads back per space", () => {
    getDb()
      .prepare(`INSERT INTO spaces (id, label) VALUES ('sp_goa', 'Goa trip with Rohan in December')`)
      .run();
    writeClaimVersion(base());
    expect(linkClaimToSpace("sp_goa", "rohan.preference.coffee", "orient")).toBe(true);
    expect(linkClaimToSpace("sp_goa", "rohan.preference.coffee")).toBe(false); // idempotent
    const inSpace = claimsInSpace("sp_goa");
    expect(inSpace).toHaveLength(1);
    expect(inSpace[0]!.claimKey).toBe("rohan.preference.coffee");
  });
});

describe("tone profiles", () => {
  it("upserts per person/stream, accumulates terms, keeps discriminating sticky", () => {
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    upsertToneProfile({
      personEntityId: rohan.id,
      register: "casual",
      languageMix: "Hinglish",
      emojiHabits: "🔥-heavy",
      addressTerms: [{ term: "bro", class: "generic", count: 3 }],
    });
    const p1 = getToneProfile(rohan.id, null);
    expect(p1?.register).toBe("casual");
    expect(p1?.addressTerms).toEqual([{ term: "bro", class: "generic", count: 3 }]);

    upsertToneProfile({
      personEntityId: rohan.id,
      addressTerms: [
        { term: "bro", class: "generic", count: 2 },
        { term: "rondu", class: "discriminating", count: 1 },
      ],
    });
    const p2 = getToneProfile(rohan.id, null)!;
    expect(p2.register).toBe("casual"); // COALESCE keeps prior value
    expect(p2.addressTerms).toEqual([
      { term: "bro", class: "generic", count: 5 },
      { term: "rondu", class: "discriminating", count: 1 },
    ]);
    // Once discriminating, always discriminating.
    upsertToneProfile({ personEntityId: rohan.id, addressTerms: [{ term: "rondu", class: "generic", count: 4 }] });
    const rondu = getToneProfile(rohan.id, null)!.addressTerms.find((t) => t.term === "rondu")!;
    expect(rondu).toEqual({ term: "rondu", class: "discriminating", count: 5 });

    // Decisions recorded for create + updates.
    expect(decisionsFor("tone_profile", p2.id).length).toBeGreaterThanOrEqual(3);
  });

  it("scopes person-only, stream-only and pair separately; requires a scope", () => {
    const rohan = createEntity({ type: "person", canonical: "Rohan" });
    getDb()
      .prepare(`INSERT INTO sources (id, type, name) VALUES ('wa','whatsapp','wa')`)
      .run();
    getDb()
      .prepare(`INSERT INTO streams (id, source_id, external_key) VALUES ('st_goa', 'wa', 'goa@g.us')`)
      .run();
    upsertToneProfile({ personEntityId: rohan.id, register: "casual" });
    upsertToneProfile({ streamId: "st_goa", register: "playful" });
    upsertToneProfile({ personEntityId: rohan.id, streamId: "st_goa", register: "terse" });
    expect(getToneProfile(rohan.id, null)?.register).toBe("casual");
    expect(getToneProfile(null, "st_goa")?.register).toBe("playful");
    expect(getToneProfile(rohan.id, "st_goa")?.register).toBe("terse");
    expect(() => upsertToneProfile({ register: "x" })).toThrow(/at least one/);
  });
});
