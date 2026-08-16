// ===========================================================================
// The entity-graph audit (arch §14.2 rows `identities silently guessed`,
// `resolution recall`, `metadata edges captured`).
//
// The point of these tests is that the audit CAN FAIL. A gate whose measurement
// only ever returns zero is not a gate, so every check below builds the guilty
// graph first and asserts the audit names it — then builds the clean one and
// asserts it does not.
//
// The headline is the [ML]-on-stale-calibration case: a merge decided by
// `ml:entity_name` with no calibration row is exactly the failure §10.3 exists
// to stop, and the audit has to see it whatever the merge itself recorded.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { putCalib } from "../db/calib.js";
import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import {
  auditMetadataEdges,
  auditResolutionRecall,
  auditResolutions,
  auditSilentGuesses,
  mlUseCaseOf,
} from "./audit.js";
import { bindGroupParticipants, recordMention } from "./binding.js";
import { listEdges, writeEdge } from "./edges.js";
import { putIdentity } from "./identities.js";
import { mergeEntities, recordDecision } from "./merge.js";
import { createEntity } from "./registry.js";

const MODEL = "Xenova/multilingual-e5-small";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ent-audit-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function calibrated(): void {
  putCalib({
    model: MODEL,
    useCase: "entity_name",
    floor: 0.8,
    nPairs: 1200,
    measuredAt: new Date().toISOString(),
  });
}

function twoPeople(): { left: string; right: string } {
  const left = createEntity({ type: "person", canonical: "Papa" }).id;
  const right = createEntity({ type: "person", canonical: "Papa (new number Jio)" }).id;
  return { left, right };
}

function anEvent(): string {
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  const streamId = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "c1", kind: "dm" });
  const actorId = upsertActor({ sourceId: "whatsapp", sourceExtId: "a1", displayName: "a1" });
  return insertEvent({
    externalId: "c1/e1",
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId,
    actorId,
    ts: "2026-08-14T09:10+05:30",
    kind: "message",
    text: "Babbu said he'll come by evening",
    mediaPath: null,
    rawJson: null,
    isHistorical: true,
  }).id;
}

describe("auditSilentGuesses", () => {
  it("passes a merge the user decided", () => {
    const { left, right } = twoPeople();
    mergeEntities({ loser: right, winner: left, actor: "user", reason: "same person" });
    expect(auditSilentGuesses()).toEqual([]);
    expect(auditResolutions().some((a) => a.subject === "merge")).toBe(true);
  });

  it("catches an [ML] merge made with NO calibration", () => {
    const { left, right } = twoPeople();
    mergeEntities({ loser: right, winner: left, actor: "ml:entity_name", reason: "0.93" });
    const guesses = auditSilentGuesses();
    expect(guesses.length).toBeGreaterThan(0);
    expect(guesses.every((g) => g.kind === "stale_calibration")).toBe(true);
    expect(guesses[0].reason).toContain("missing");
  });

  it("catches an [ML] merge made with STALE calibration", () => {
    putCalib({
      model: MODEL,
      useCase: "entity_name",
      floor: 0.8,
      nPairs: 1200,
      measuredAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString(),
    });
    const { left, right } = twoPeople();
    mergeEntities({ loser: right, winner: left, actor: "ml:entity_name", reason: "0.93" });
    expect(auditSilentGuesses().map((g) => g.kind)).toContain("stale_calibration");
  });

  it("passes the same [ML] merge once the floor is measured", () => {
    calibrated();
    const { left, right } = twoPeople();
    mergeEntities({ loser: right, winner: left, actor: "ml:entity_name", reason: "0.93" });
    expect(auditSilentGuesses()).toEqual([]);
  });

  it("catches a merge with no resolution_decisions row at all", () => {
    const { left, right } = twoPeople();
    getDb().prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(left, right);
    expect(auditSilentGuesses().map((g) => g.kind)).toEqual(["no_decision_row"]);
  });

  it("catches a merge a model decided — llm is not a rung of the ladder", () => {
    const { left, right } = twoPeople();
    mergeEntities({ loser: right, winner: left, actor: "llm:p-ep1", reason: "looks the same" });
    expect(auditSilentGuesses().map((g) => g.kind)).toContain("not_a_rung");
  });

  it("catches a threshold invented in code — an [ML] bind below the measured bar", () => {
    calibrated();
    const { left, right } = twoPeople();
    mergeEntities({ loser: right, winner: left, actor: "ml:entity_name", reason: "0.4" });
    getDb()
      .prepare(
        `INSERT INTO mutations (id, actor, target_kind, target_id, field, new_json)
         VALUES ('mut_x', 'ml:entity_name', 'entity_pair', ?, 'resolution', ?)`,
      )
      .run(`${left}|${right}`, JSON.stringify({ rung: "ml", confidence: 0.4, score: 0.4 }));
    const guesses = auditSilentGuesses();
    expect(guesses.map((g) => g.kind)).toContain("invented_threshold");
  });

  it("catches an identity filed with no decider", () => {
    const { left } = twoPeople();
    getDb()
      .prepare(
        `INSERT INTO entity_identities (id, entity_id, source_id, kind, value_norm, confidence, decided_by)
         VALUES ('eid_x', ?, 'whatsapp', 'jid', '919800000001@s.whatsapp.net', 1, NULL)`,
      )
      .run(left);
    expect(auditSilentGuesses().map((g) => g.kind)).toEqual(["no_decider"]);
  });

  it("catches a mention linked to an entity with no confidence", () => {
    const { left } = twoPeople();
    const eventId = anEvent();
    const mention = recordMention({
      eventId,
      surface: "Babbu",
      entityId: left,
      confidence: 0.9,
      decidedBy: "code:roster",
    });
    expect(auditSilentGuesses()).toEqual([]);
    getDb().prepare(`UPDATE mentions SET confidence = NULL WHERE id = ?`).run(mention.id);
    expect(auditSilentGuesses().map((g) => g.kind)).toEqual(["no_confidence"]);
  });

  it("does not audit a mention that landed on nothing — unknown beats wrong", () => {
    const eventId = anEvent();
    recordMention({
      eventId,
      surface: "the broker",
      entityId: null,
      hint: "the broker",
      confidence: 0.5,
      decidedBy: "code:unresolved",
    });
    expect(auditResolutions().some((a) => a.subject === "mention")).toBe(false);
  });

  it("examines every committed resolution, not only the guilty ones", () => {
    calibrated();
    const { left, right } = twoPeople();
    putIdentity({ entityId: left, sourceId: "whatsapp", kind: "jid", value: "1@s.whatsapp.net", confidence: 1, decidedBy: "code:mint" });
    putIdentity({ entityId: right, sourceId: "whatsapp", kind: "jid", value: "2@s.whatsapp.net", confidence: 1, decidedBy: "code:mint" });
    recordDecision({ left, right, verdict: "different", decidedBy: "user" });
    const audits = auditResolutions();
    expect(audits.filter((a) => a.subject === "identity")).toHaveLength(2);
    // A `different` is not a commit, so it is not audited as one.
    expect(audits.some((a) => a.subject === "decision")).toBe(false);
    expect(audits.every((a) => a.guess === null)).toBe(true);
  });
});

describe("mlUseCaseOf", () => {
  it("reads the calibrated channel out of the decider", () => {
    expect(mlUseCaseOf("ml:entity_name")).toBe("entity_name");
    expect(mlUseCaseOf("ml:entity_name:refused")).toBe("entity_name");
    expect(mlUseCaseOf("ml:not_a_channel")).toBeNull();
    expect(mlUseCaseOf("code:exact")).toBeNull();
    expect(mlUseCaseOf(null)).toBeNull();
  });
});

describe("auditResolutionRecall", () => {
  it("counts a phone under two sources as one join owed, and sees it made", () => {
    const person = createEntity({ type: "person", canonical: "Pranjali" }).id;
    putIdentity({ entityId: person, sourceId: "whatsapp", kind: "phone", value: "+919800000001", confidence: 1, decidedBy: "code:mint" });
    putIdentity({ entityId: person, sourceId: "contacts", kind: "phone", value: "+91 98000 00001", confidence: 1, decidedBy: "code:cross_source" });
    const recall = auditResolutionRecall();
    expect(recall).toHaveLength(1);
    expect(recall[0]).toMatchObject({ kind: "cross_source", recovered: true });
  });

  it("counts it as MISSED when the same phone sits on two entities", () => {
    const a = createEntity({ type: "person", canonical: "Pranjali" }).id;
    const b = createEntity({ type: "person", canonical: "Pranjali (contacts)" }).id;
    putIdentity({ entityId: a, sourceId: "whatsapp", kind: "phone", value: "+919800000001", confidence: 1, decidedBy: "code:mint" });
    putIdentity({ entityId: b, sourceId: "contacts", kind: "phone", value: "+919800000001", confidence: 1, decidedBy: "code:mint" });
    const recall = auditResolutionRecall();
    expect(recall.filter((r) => r.kind === "cross_source")).toHaveLength(1);
    expect(recall[0].recovered).toBe(false);
    expect(recall[0].reason).toContain("2 entities");
  });

  it("owes no join for a handle — two networks, two people", () => {
    const a = createEntity({ type: "person", canonical: "Rahul (slack)" }).id;
    const b = createEntity({ type: "person", canonical: "Rahul (x)" }).id;
    putIdentity({ entityId: a, sourceId: "slack", kind: "handle", value: "rahul", confidence: 1, decidedBy: "code:mint" });
    putIdentity({ entityId: b, sourceId: "x", kind: "handle", value: "rahul", confidence: 1, decidedBy: "code:mint" });
    expect(auditResolutionRecall()).toEqual([]);
  });

  it("counts a stored `same` verdict as a join owed", () => {
    const { left, right } = twoPeople();
    recordDecision({ left, right, verdict: "same", decidedBy: "agent:p-ag1" });
    const missed = auditResolutionRecall();
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ kind: "decided_same", recovered: false });

    mergeEntities({ loser: right, winner: left, actor: "agent:p-ag1" });
    expect(auditResolutionRecall()[0].recovered).toBe(true);
  });
});

describe("auditMetadataEdges", () => {
  function aGroup(): { container: string; members: string[] } {
    const res = bindGroupParticipants({
      sourceId: "whatsapp",
      group: { kind: "jid", value: "1203630111@g.us", displayName: "Ghar+", subtype: "family" },
      participants: [
        { kind: "jid", value: "919800000001@s.whatsapp.net" },
        { kind: "jid", value: "919800000002@s.whatsapp.net" },
      ],
    });
    return { container: res.containerEntityId, members: res.memberEntityIds };
  }

  it("passes when every member the source named has its free edge", () => {
    const { container, members } = aGroup();
    const checks = auditMetadataEdges(
      members.map((memberEntityId) => ({ memberEntityId, containerEntityId: container, kind: "affiliated_with" as const })),
    );
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.captured)).toBe(true);
  });

  it("fails when one member's edge is missing", () => {
    const { container, members } = aGroup();
    const edge = listEdges().find((e) => e.srcEntityId === members[0])!;
    getDb().prepare(`DELETE FROM entity_edges WHERE id = ?`).run(edge.id);
    const checks = auditMetadataEdges(
      members.map((memberEntityId) => ({ memberEntityId, containerEntityId: container, kind: "affiliated_with" as const })),
    );
    expect(checks.filter((c) => !c.captured)).toHaveLength(1);
    expect(checks[0].reason).toContain("no active affiliated_with edge");
  });

  it("fails when the edge exists but a model wrote it instead of the source", () => {
    const container = createEntity({ type: "group", canonical: "Goa Crew" }).id;
    const member = createEntity({ type: "person", canonical: "Rahul" }).id;
    const eventId = anEvent();
    writeEdge({
      kind: "affiliated_with",
      subtype: "member",
      srcEntityId: member,
      dstEntityId: container,
      confidence: 0.7,
      decidedBy: "llm:p-ep1",
      eventId,
      quote: "Rahul is in the Goa group",
    });
    const [check] = auditMetadataEdges([
      { memberEntityId: member, containerEntityId: container, kind: "affiliated_with" },
    ]);
    expect(check.captured).toBe(false);
    expect(check.reason).toContain("not code:metadata");
  });
});
