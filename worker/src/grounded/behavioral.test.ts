// ===========================================================================
// Behavioral memory (V6 P1 S5.5, FIX-08). A correction on ONE thing becomes a
// rule about the NEXT one. Rules are claims — versioned, ended, never
// overwritten — so the suite asserts both halves: what is written, and what
// the surface router reads back before it shows anything. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claimHistory } from "../claims/store.js";
import { closeDb, runMigrations } from "../db/connection.js";
import {
  behavioralClaimKey,
  listBehavioralRules,
  retireBehavioralRule,
  ruleApplies,
  suppressingRules,
  writeBehavioralRule,
} from "./behavioral.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-behavioral-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const YOUTUBE = {
  rule: "no cards while YouTube is frontmost",
  scope: "router",
  kind: "something_moved",
  context: "app:YouTube",
  evidence: "stop nudging me about fares on youtube",
};

describe("writeBehavioralRule", () => {
  it("writes the rule with its verbatim evidence and lists it back", () => {
    const row = writeBehavioralRule(YOUTUBE);
    expect(row.rule).toBe(YOUTUBE.rule);
    expect(row.scope).toBe("router");
    expect(row.context).toBe("app:YouTube");
    expect(row.evidence).toBe(YOUTUBE.evidence);

    const listed = listBehavioralRules();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.claim_key).toBe(row.claim_key);
  });

  it("the same rule said twice reinforces — one active row, two versions", () => {
    const first = writeBehavioralRule(YOUTUBE);
    const second = writeBehavioralRule({ ...YOUTUBE, evidence: "seriously, stop" });
    expect(second.claim_key).toBe(first.claim_key);
    expect(listBehavioralRules()).toHaveLength(1);
    // Versioned, not overwritten: the first version is still there, ended.
    expect(claimHistory(first.claim_key)).toHaveLength(2);
  });

  it("keys on (rule, scope) so a different scope is a different rule", () => {
    expect(behavioralClaimKey("no cards", "router")).not.toBe(behavioralClaimKey("no cards", "nudge"));
    writeBehavioralRule({ ...YOUTUBE, scope: "router" });
    writeBehavioralRule({ ...YOUTUBE, scope: "nudge" });
    expect(listBehavioralRules()).toHaveLength(2);
  });

  it("refuses an empty rule", () => {
    expect(() => writeBehavioralRule({ ...YOUTUBE, rule: "   " })).toThrow(/not a rule/);
  });
});

describe("retireBehavioralRule", () => {
  it("ends the rule, keeps the history, and is honest about a miss", () => {
    const row = writeBehavioralRule(YOUTUBE);
    expect(retireBehavioralRule(row.claim_key)).toBe(true);
    expect(listBehavioralRules()).toHaveLength(0);
    expect(claimHistory(row.claim_key).length).toBeGreaterThan(0);
    expect(retireBehavioralRule("behavioral.nope")).toBe(false);
  });
});

describe("ruleApplies — the read the surface router does before it shows anything", () => {
  it("suppresses the next decision in the context the rule named", () => {
    const row = writeBehavioralRule(YOUTUBE);
    expect(ruleApplies(row, { app: "YouTube", kind: "something_moved", surface: "router" })).toBe(true);
  });

  it("does not suppress a decision in another app", () => {
    const row = writeBehavioralRule(YOUTUBE);
    expect(ruleApplies(row, { app: "Mail", kind: "something_moved", surface: "router" })).toBe(false);
  });

  it("does not suppress another kind in the same app", () => {
    const row = writeBehavioralRule(YOUTUBE);
    expect(ruleApplies(row, { app: "YouTube", kind: "help_now", surface: "router" })).toBe(false);
  });

  it("a rule scoped to a stream matches that stream only", () => {
    const row = writeBehavioralRule({
      rule: "never nudge from the batchmates group",
      scope: "nudge",
      context: "stream:wa:batch",
      evidence: "stop showing me this group",
    });
    expect(ruleApplies(row, { stream: "wa:batch", surface: "nudge" })).toBe(true);
    expect(ruleApplies(row, { stream: "wa:family", surface: "nudge" })).toBe(false);
  });

  it("an unqualified global rule is guidance, not a kill switch", () => {
    const row = writeBehavioralRule({ rule: "be brief", scope: "global", evidence: "you're too wordy" });
    expect(ruleApplies(row, { app: "YouTube", kind: "something_moved", surface: "router" })).toBe(false);
  });

  it("suppressingRules reads the live list", () => {
    writeBehavioralRule(YOUTUBE);
    writeBehavioralRule({ rule: "be brief", scope: "global", evidence: "too wordy" });
    const hits = suppressingRules({ app: "YouTube", kind: "something_moved", surface: "router" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.rule).toBe(YOUTUBE.rule);
    expect(suppressingRules({ app: "Mail", kind: "something_moved", surface: "router" })).toHaveLength(0);
  });
});
