// ===========================================================================
// Identity rows and their normalisation (build item 1.5, arch §10.3).
//
// The normalisers are tested for what they DO NOT do as much as what they do:
// a number with no country code does not acquire one, an email does not lose
// its plus-tag, a jid does not lose its domain. Every one of those "helpful"
// rewrites is a cross-source join onto the wrong person.
//
// The cross-source rule gets its own block, because it is the single line
// between "one Rahul" and "two people who both picked @rahul".
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import {
  CROSS_SOURCE_KINDS,
  IDENTITY_KINDS,
  findCrossSource,
  findIdentity,
  identitiesOf,
  isCrossSourceKind,
  normaliseAlias,
  normaliseEmail,
  normaliseHandle,
  normaliseJid,
  normalisePhone,
  phoneFromJid,
  putIdentity,
} from "./identities.js";
import { createEntity } from "./registry.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ent-ident-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("normalisation", () => {
  it("folds phone separators without inventing a country code", () => {
    expect(normalisePhone("+91 98000 00001")).toBe("+919800000001");
    expect(normalisePhone("+91-98000-00001")).toBe("+919800000001");
    expect(normalisePhone("0091 98000 00001")).toBe("+919800000001");
    // No leading +, no country: it stays exactly as many digits as it was.
    expect(normalisePhone("9800000001")).toBe("9800000001");
    expect(normalisePhone("9800000001")).not.toBe("+919800000001");
  });

  it("lower-cases email and keeps the plus-tag", () => {
    expect(normaliseEmail("  Pranjali@X.com ")).toBe("pranjali@x.com");
    expect(normaliseEmail("rahul+goa@x.com")).toBe("rahul+goa@x.com");
  });

  it("drops a jid's multi-device suffix and keeps its domain", () => {
    expect(normaliseJid("919800000001:12@s.whatsapp.net")).toBe("919800000001@s.whatsapp.net");
    expect(normaliseJid("120363@G.US")).toBe("120363@g.us");
  });

  it("strips a leading @ from a handle and collapses alias whitespace", () => {
    expect(normaliseHandle("@Rahul")).toBe("rahul");
    expect(normaliseAlias("  Meri   Didi ")).toBe("meri didi");
  });

  it("reads the phone out of a person jid and refuses to invent one", () => {
    expect(phoneFromJid("919800000001@s.whatsapp.net")).toBe("+919800000001");
    expect(phoneFromJid("120363001@g.us")).toBeNull();
    expect(phoneFromJid("83741@lid")).toBeNull();
    expect(phoneFromJid("not-a-jid")).toBeNull();
  });
});

describe("the cross-source rule", () => {
  it("names phone and email, and nothing else", () => {
    expect([...CROSS_SOURCE_KINDS]).toEqual(["phone", "email"]);
    for (const kind of IDENTITY_KINDS) {
      expect(isCrossSourceKind(kind)).toBe(kind === "phone" || kind === "email");
    }
  });

  it("joins a phone across two sources", () => {
    const e = createEntity({ type: "person", canonical: "Pranjali" });
    putIdentity({ entityId: e.id, sourceId: "whatsapp", kind: "phone", value: "+919800000001", decidedBy: "code:mint" });
    const hits = findCrossSource("phone", "+91 98000 00001");
    expect(hits.map((h) => h.entityId)).toEqual([e.id]);
  });

  it("refuses to join a handle across two sources", () => {
    const slack = createEntity({ type: "person", canonical: "Rahul (slack)" });
    const x = createEntity({ type: "person", canonical: "rahul (x)" });
    putIdentity({ entityId: slack.id, sourceId: "slack", kind: "handle", value: "@rahul", decidedBy: "code:mint" });
    putIdentity({ entityId: x.id, sourceId: "x", kind: "handle", value: "@rahul", decidedBy: "code:mint" });

    expect(findCrossSource("handle", "@rahul")).toEqual([]);
    expect(findIdentity("slack", "handle", "@rahul")?.entityId).toBe(slack.id);
    expect(findIdentity("x", "handle", "@rahul")?.entityId).toBe(x.id);
  });
});

describe("rows", () => {
  it("is idempotent on (source, kind, value_norm)", () => {
    const e = createEntity({ type: "person" });
    const first = putIdentity({
      entityId: e.id,
      sourceId: "whatsapp",
      kind: "jid",
      value: "919800000001@s.whatsapp.net",
      confidence: 1,
      decidedBy: "code:mint",
    });
    const again = putIdentity({
      entityId: e.id,
      sourceId: "whatsapp",
      kind: "jid",
      value: "919800000001:9@S.WHATSAPP.NET",
      confidence: 1,
      decidedBy: "code:exact",
    });
    expect(again.id).toBe(first.id);
    expect(identitiesOf(e.id)).toHaveLength(1);
  });

  it("records who decided and how sure, on every row", () => {
    const e = createEntity({ type: "person" });
    const row = putIdentity({
      entityId: e.id,
      sourceId: "gmail",
      kind: "email",
      value: "Pranjali@X.com",
      confidence: 1,
      decidedBy: "code:cross_source",
    });
    expect(row.decidedBy).toBe("code:cross_source");
    expect(row.confidence).toBe(1);
    expect(row.decidedAt).toBeTruthy();
    expect(row.valueNorm).toBe("pranjali@x.com");
  });

  it("refuses a blank decider and an empty value", () => {
    const e = createEntity({ type: "person" });
    expect(() =>
      putIdentity({ entityId: e.id, sourceId: "s", kind: "phone", value: "+91 98000 00001", decidedBy: "" }),
    ).toThrow(/decided_by/);
    expect(() =>
      putIdentity({ entityId: e.id, sourceId: "s", kind: "phone", value: "  ", decidedBy: "code:mint" }),
    ).toThrow(/normalised to empty/);
  });
});
