// ===========================================================================
// Circles (V6 P1 S5.4) — inferred from content, tone, claims and metadata,
// with reply VOLUME as one weak signal worth at most a tenth of a circle.
// Zero model calls. CIR-01..04 and CRM-05 live here as unit cases; the eval
// executor drives the same functions from the fixtures.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { writeClaimVersion } from "../claims/store.js";
import { createEntity, circleOf, setCircle } from "../entities/registry.js";
import {
  applicability,
  circleFromRelationship,
  circlePriority,
  CIRCLE_WEIGHT,
  inferCircle,
  inferCirclesForUnassigned,
  rankByPriority,
  signalsForPerson,
} from "./circles.js";

describe("inferCircle — content, tone, claims, metadata", () => {
  it("CIR-01: a quiet family group is family, and volume never makes it otherwise", () => {
    const family = inferCircle({
      contactName: "Ma",
      groupLabel: "Family",
      isGroup: true,
      memberCount: 5,
      userReplyCount: 4,
      sampleTexts: ["doctor appointment 4 baje hai", "papa ko bata dena"],
    });
    expect(family.circle).toBe("family");
    expect(family.signals).toContain("metadata");
    expect(family.signals).toContain("content");

    const memes = inferCircle({
      groupLabel: "College Memes",
      isGroup: true,
      memberCount: 60,
      userReplyCount: 40,
      sampleTexts: ["lmao", "forwarded meme", "😂😂"],
    });
    expect(memes.circle).not.toBe("family");
    expect(["acquaintances", "old_batchmates", "friends"]).toContain(memes.circle);
  });

  it("CIR-02: sparse service traffic is important-services, not acquaintance junk", () => {
    const inf = inferCircle({
      contactName: null,
      isGroup: false,
      spanDays: 180,
      theirMessageCount: 5,
      userReplyCount: 2,
      sampleTexts: ["aunty maid coming at 4", "salary 6000 for feb"],
    });
    expect(inf.circle).toBe("important_services");
    expect(inf.reasons.join(" ")).toMatch(/service role/i);
  });

  it("a relationship claim is a strong vote", () => {
    expect(circleFromRelationship("Riya — cousin")).toBe("family");
    expect(circleFromRelationship("works with me at Falcon, colleague")).toBe("coworkers");
    expect(circleFromRelationship("our maid")).toBe("important_services");
    expect(circleFromRelationship("nothing useful")).toBeNull();
    const inf = inferCircle({ contactName: "Riya", relationshipClaims: ["cousin"], sampleTexts: ["hey"] });
    expect(inf.circle).toBe("family");
  });

  it("a big never-replied group reads as acquaintances", () => {
    const inf = inferCircle({ groupLabel: "Sunrise Apartments 402", isGroup: true, memberCount: 180, userReplyCount: 0, sampleTexts: ["society water tank cleaning sunday"] });
    expect(inf.circle).toBe("acquaintances");
  });

  it("no signal at all → null, never a guess", () => {
    expect(inferCircle({}).circle).toBeNull();
  });
});

describe("priority — CRM-05: quiet family outranks chatty acquaintances", () => {
  it("circle weight dominates; volume adds at most 0.1", () => {
    const family = circlePriority({ id: "fam", circle: "family", userReplyCount: 4 });
    const memes = circlePriority({ id: "memes", circle: "acquaintances", userReplyCount: 40 });
    expect(family.score).toBeGreaterThan(memes.score);
    expect(memes.score - CIRCLE_WEIGHT.acquaintances).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(family.explanation).toContain("weak");
  });

  it("even an absurd reply count cannot lift acquaintances over family", () => {
    const memes = circlePriority({ id: "memes", circle: "acquaintances", userReplyCount: 100_000 });
    expect(memes.score).toBeLessThan(circlePriority({ id: "fam", circle: "family", userReplyCount: 0 }).score);
  });

  it("content urgency adds at most 0.2 and ranks inside a circle", () => {
    const ranked = rankByPriority([
      { id: "memes", circle: "acquaintances", userReplyCount: 40 },
      { id: "ma", circle: "family", userReplyCount: 4, contentUrgency: 1 },
      { id: "cousin", circle: "family", userReplyCount: 0 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["ma", "cousin", "memes"]);
  });
});

describe("applicability — CIR-03: the same words weigh differently by where they land", () => {
  it("a 180-member never-replied broadcast is a note; Ma in Family is a task", () => {
    const society = applicability({ circle: "acquaintances", isGroup: true, memberCount: 180, userReplied: false, directAddress: false });
    expect(society.verdict).toBe("note");
    expect(society.reason).toContain("180");

    const ma = applicability({ circle: "family", isGroup: true, memberCount: 5, userReplied: true, directAddress: false });
    expect(ma.verdict).toBe("task");
  });

  it("a direct address is a task wherever it lands", () => {
    expect(applicability({ circle: "acquaintances", isGroup: true, memberCount: 180, userReplied: false, directAddress: true }).verdict).toBe("task");
  });

  it("business and batchmate broadcasts are notes at most", () => {
    expect(applicability({ circle: "businesses", isGroup: false, userReplied: false, directAddress: false }).verdict).toBe("ignore");
    expect(applicability({ circle: "old_batchmates", isGroup: true, memberCount: 12, userReplied: true, directAddress: false }).verdict).toBe("note");
  });
});

describe("inference over the record", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "supertwin-circles-"));
    process.env.SUPERTWIN_HOME = tmpDir;
    process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
    closeDb();
    runMigrations();
  });

  afterEach(() => {
    closeDb();
    delete process.env.SUPERTWIN_HOME;
    delete process.env.SUPERTWIN_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSource(): string {
    getDb().prepare(`INSERT INTO sources (id, type, display_name) VALUES ('src_wa', 'whatsapp', 'WhatsApp')`).run();
    getDb()
      .prepare(`INSERT INTO streams (id, source_id, external_key, label, stream_kind) VALUES ('str_dm', 'src_wa', 'maid@s.whatsapp.net', 'Maid', 'dm')`)
      .run();
    return "str_dm";
  }

  it("signalsForPerson reads names, claims and their messages", () => {
    const stream = seedSource();
    const maid = createEntity({ type: "person", canonical: "Sunita", provisional: true });
    writeClaimVersion({
      claimKey: `person.${maid.id}.relationship`,
      kind: "relationship",
      subjectId: maid.id,
      text: "our maid",
      confidence: 0.9,
      statedAt: "2026-03-01T00:00:00.000Z",
      evidence: [{ quote: "aunty maid coming at 4", event_ids: [] }],
      decidedBy: "llm:extract",
    });
    for (const [i, text] of ["aunty maid coming at 4", "salary 6000 for feb"].entries()) {
      getDb()
        .prepare(
          `INSERT INTO events (id, source_id, stream_id, ts, tz, kind, text, is_self, enrichment_state, actor_entity_id, ingested_at, stream_key, actor)
           VALUES (?, 'src_wa', ?, ?, 'Asia/Kolkata', 'wa.message', ?, 0, 'none', ?, ?, 'maid@s.whatsapp.net', 'contact:maid')`,
        )
        .run(`ev_m${i}`, stream, `2026-0${i + 2}-01T10:00:00.000Z`, text, maid.id, "2026-08-01T00:00:00.000Z");
    }
    const s = signalsForPerson(maid.id);
    expect(s.contactName).toBe("Sunita");
    expect(s.relationshipClaims).toContain("our maid");
    expect(s.theirMessageCount).toBe(2);
    expect(inferCircle(s).circle).toBe("important_services");
  });

  it("inferCirclesForUnassigned assigns and never overwrites a user's drag", () => {
    const stream = seedSource();
    const maid = createEntity({ type: "person", canonical: "Sunita", provisional: true });
    const priya = createEntity({ type: "person", canonical: "Priya", provisional: false });
    for (const [i, text] of ["aunty maid coming at 4", "salary 6000 for feb"].entries()) {
      getDb()
        .prepare(
          `INSERT INTO events (id, source_id, stream_id, ts, tz, kind, text, is_self, enrichment_state, actor_entity_id, ingested_at, stream_key, actor)
           VALUES (?, 'src_wa', ?, ?, 'Asia/Kolkata', 'wa.message', ?, 0, 'none', ?, ?, 'maid@s.whatsapp.net', 'contact:maid')`,
        )
        .run(`ev_s${i}`, stream, `2026-0${i + 2}-01T10:00:00.000Z`, text, maid.id, "2026-08-01T00:00:00.000Z");
    }
    // CIR-04: the user dragged Priya to close friends. Code must not undo it.
    setCircle(priya.id, "close_friends", { decidedBy: "user", reason: "drag in People" });
    setCircle(priya.id, null, { decidedBy: "user", reason: "clear for the test" });

    const report = inferCirclesForUnassigned();
    expect(report.assigned.map((a) => a.id)).toContain(maid.id);
    expect(circleOf(maid.id)).toBe("important_services");
    expect(report.skipped.find((s) => s.id === priya.id)?.why).toBe("user-set");
    expect(circleOf(priya.id)).toBeNull();
  });
});
