// ===========================================================================
// The resolution ladder (build item 1.10, arch §10.3; evals G).
//
// The four rules the ladder exists to enforce, one block each:
//
//   * the [ML] rung is OFF with no measured floor — and reports no score;
//   * an in-band pair ESCALATES, and reaches the queue when nothing can
//     adjudicate it. It never binds and it never auto-retries;
//   * a stored `different` is permanent and is not re-proposed, above every
//     rung, at any score;
//   * the agent is never called on the first-paint path, and during bootstrap
//     is batched to horizon boundaries.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { putCalib } from "../db/calib.js";
import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { upsertSource } from "../db/ingest.js";
import { USE_CASE_BARS } from "../retrieval/calibration.js";
import { isNegativePair, openResolutionQuestions, readDecision, recordDecision } from "./merge.js";
import { createEntity, listEntities, resolveEntityId } from "./registry.js";
import { applyAgentVerdict } from "./adjudicate.js";
import {
  agentAlreadyAsked,
  assertProvenance,
  resolveIdentity,
  resolvePair,
  routePair,
} from "./resolve.js";

const MODEL = "test-embedder";
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-resolve-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function person(name: string): string {
  return createEntity({ type: "person", canonical: name, provisional: true }).id;
}

/** A measured floor for the entity-name channel. 1,200 pairs, measured now. */
function calibrate(floor = 0.8): void {
  putCalib({
    model: MODEL,
    useCase: "entity_name",
    floor,
    measuredAt: new Date().toISOString(),
    nPairs: 1200,
  });
}

function pair() {
  return { left: person("Papa (new number Jio)"), right: person("Papa") };
}

describe("rung ③ — the [ML] rung is measured or it is off", () => {
  it("is disabled with no calibration row at all, and reports NO score", () => {
    const { left, right } = pair();
    const route = routePair({ left, right, model: MODEL, score: 0.93, agentAvailable: false });
    expect(route.mlEnabled).toBe(false);
    expect(route.score).toBeNull();
    expect(route.next).toBe("queue");
    expect(route.reason).toContain("[ML] similarity disabled");
  });

  it("is disabled when the row is stale, however confident the score", () => {
    putCalib({
      model: MODEL,
      useCase: "entity_name",
      floor: 0.8,
      measuredAt: "2020-01-01T00:00:00Z",
      nPairs: 1200,
    });
    const { left, right } = pair();
    const route = routePair({ left, right, model: MODEL, score: 0.99, agentAvailable: false });
    expect(route.mlEnabled).toBe(false);
    expect(route.score).toBeNull();
  });

  it("is disabled when the row was measured from too few pairs", () => {
    putCalib({ model: MODEL, useCase: "entity_name", floor: 0.8, measuredAt: new Date().toISOString(), nPairs: 12 });
    const { left, right } = pair();
    expect(routePair({ left, right, model: MODEL, score: 0.99 }).mlEnabled).toBe(false);
  });

  it("sends a blocked pair to the queue with no agent, and binds nothing (G-069)", () => {
    const { left, right } = pair();
    const res = resolvePair({ left, right, model: MODEL, score: 0.93, agentAvailable: false });
    expect(res.outcome).toBe("queued");
    expect(res.score).toBeNull();
    expect(openResolutionQuestions()).toHaveLength(1);
    expect(resolveEntityId(right)).toBe(right);
    expect(listEntities()).toHaveLength(2);
  });

  it("normalises a raw cosine against the MEASURED floor, never a constant", () => {
    calibrate(0.8);
    const { left, right } = pair();
    // (0.96 - 0.8) / (1 - 0.8) = 0.8 — above the entity_name bind bar of 0.72.
    const route = routePair({ left, right, model: MODEL, cosine: 0.96 });
    expect(route.score).toBeCloseTo(0.8, 6);
    expect(route.next).toBe("bind");
    // The same cosine under a HIGHER floor is a different answer entirely:
    // 0.96 is a strong match against a noise band that tops out at 0.8, and
    // barely off the floor when the band tops out at 0.9 or 0.95.
    calibrate(0.9);
    expect(routePair({ left, right, model: MODEL, cosine: 0.96 }).score).toBeCloseTo(0.6, 6);
    expect(routePair({ left, right, model: MODEL, cosine: 0.96 }).next).toBe("agent");
    calibrate(0.95);
    expect(routePair({ left, right, model: MODEL, cosine: 0.96 }).next).toBe("different");
  });

  it("binds at or above the bind bar, with decided_by and confidence (G-070)", () => {
    calibrate();
    const { left, right } = pair();
    const res = resolvePair({ left, right, model: MODEL, score: 0.9 });
    expect(res.outcome).toBe("merged");
    expect(res.rung).toBe("ml");
    expect(res.decidedBy).toBe("ml:entity_name");
    expect(res.confidence).toBe(0.9);
    expect(resolveEntityId(right)).toBe(left);

    const provenance = (
      getDb()
        .prepare(`SELECT new_json FROM mutations WHERE field = 'resolution'`)
        .all() as { new_json: string }[]
    ).map((r) => JSON.parse(r.new_json) as { rung: string; decidedBy: string; confidence: number });
    expect(provenance).toEqual([{ rung: "ml", decidedBy: "ml:entity_name", confidence: 0.9, score: 0.9 }]);
  });

  it("does NOT write a decision for a below-band pair — a low score is not a verdict", () => {
    calibrate();
    const { left, right } = pair();
    const res = resolvePair({ left, right, model: MODEL, score: 0.1 });
    expect(res.outcome).toBe("different");
    expect(readDecision(left, right)).toBeNull();
    expect(isNegativePair(left, right)).toBe(false);
  });

  it("escalates a calibrated pair that carries no similarity at all", () => {
    calibrate();
    const { left, right } = pair();
    const route = routePair({ left, right, model: MODEL });
    expect(route.mlEnabled).toBe(true);
    expect(route.score).toBeNull();
    expect(route.next).toBe("agent");
  });
});

describe("rung ⑤ — in-band pairs become questions (G-045..050)", () => {
  it("escalates an in-band score to the agent and binds nothing", () => {
    calibrate();
    const { left, right } = pair();
    const bars = USE_CASE_BARS.entity_name;
    const inBand = (bars.bind + bars.band) / 2;
    const res = resolvePair({ left, right, model: MODEL, score: inBand });
    expect(res.outcome).toBe("deferred");
    expect(res.rung).toBe("agent");
    expect(resolveEntityId(right)).toBe(right);
  });

  it("falls to the queue when there is no agent lane, and records `unsure`", () => {
    calibrate();
    const { left, right } = pair();
    const res = resolvePair({ left, right, model: MODEL, score: 0.5, agentAvailable: false });
    expect(res.outcome).toBe("queued");
    expect(res.rung).toBe("queue");
    expect(readDecision(left, right)?.verdict).toBe("unsure");
    expect(openResolutionQuestions()).toHaveLength(1);
  });

  it("never auto-retries a pair the agent already answered `un` on", () => {
    calibrate();
    const { left, right } = pair();
    applyAgentVerdict(
      { left, right, verdict: "unsure", confidence: 0.4, reason: "conflicting evidence" },
      { left, right },
    );
    expect(agentAlreadyAsked(left, right)).toBe(true);

    // A second pass over the same pair, in band again: it goes to the human,
    // NOT back to the agent. Nothing about the pair has changed.
    const again = routePair({ left, right, model: MODEL, score: 0.5 });
    expect(again.next).toBe("queue");
    expect(again.decidedBy).toBe("agent:p-ag1:unsure");
  });
});

describe("above every rung — a stored `different` is permanent (G-051..054)", () => {
  it("refuses to re-propose a user `different`, at any score", () => {
    calibrate();
    const { left, right } = pair();
    recordDecision({ left, right, verdict: "different", decidedBy: "user", reason: "not the same Amit" });

    const res = resolvePair({ left, right, model: MODEL, score: 0.93 });
    expect(res.outcome).toBe("refused");
    expect(res.refused).toBe("negative_pair");
    expect(resolveEntityId(right)).toBe(right);
    expect(readDecision(left, right)?.decidedBy).toBe("user");
    expect(readDecision(left, right)?.verdict).toBe("different");
    // Refusing is not asking: no new question is raised either.
    expect(openResolutionQuestions()).toHaveLength(0);
  });

  it("refuses a pair that already resolves to one entity, and a missing one", () => {
    calibrate();
    const { left } = pair();
    expect(routePair({ left, right: left }).refused).toBe("same_entity");
    expect(routePair({ left, right: "ent_nope" }).refused).toBe("missing");
  });
});


describe("the whole ladder for one incoming identity", () => {
  it("stops at rung ① on an exact hit and escalates nothing", () => {
    const first = resolveIdentity({ sourceId: "whatsapp", kind: "jid", value: "919800000001@s.whatsapp.net" });
    const again = resolveIdentity({ sourceId: "whatsapp", kind: "jid", value: "919800000001@s.whatsapp.net" });
    expect(again.rung).toBe("exact");
    expect(again.bind.entityId).toBe(first.bind.entityId);
    expect(again.escalations).toEqual([]);
  });

  it("stops at rung ② on a cross-source phone, at confidence 1.0", () => {
    resolveIdentity({ sourceId: "whatsapp", kind: "jid", value: "919800000001@s.whatsapp.net" });
    upsertSource({ id: "contacts", type: "contacts", name: "Contacts" });
    const joined = resolveIdentity({ sourceId: "contacts", kind: "phone", value: "+919800000001" });
    expect(joined.rung).toBe("cross_source");
    expect(joined.bind.confidence).toBe(1);
    expect(joined.escalations).toEqual([]);
  });

  it("escalates only a MINT, and only against the candidates it was given", () => {
    calibrate();
    const existing = person("Papa");
    const res = resolveIdentity({
      sourceId: "whatsapp",
      kind: "jid",
      value: "919812000021@s.whatsapp.net",
      displayName: "Papa (new number Jio)",
      candidates: [existing],
      scores: { [existing]: 0.95 },
      ladder: { model: MODEL },
    });
    expect(res.bind.rung).toBe("mint");
    expect(res.escalations).toHaveLength(1);
    expect(res.escalations[0].outcome).toBe("merged");
    expect(resolveEntityId(res.bind.entityId)).toBe(existing);
  });

  it("skips a candidate the user already said is different", () => {
    calibrate();
    const existing = person("Papa");
    const minted = resolveIdentity({
      sourceId: "whatsapp",
      kind: "jid",
      value: "919812000021@s.whatsapp.net",
      displayName: "Papa (new number Jio)",
    });
    recordDecision({ left: existing, right: minted.bind.entityId, verdict: "different", decidedBy: "user" });
    const res = resolveIdentity({
      sourceId: "whatsapp",
      kind: "jid",
      value: "919812000022@s.whatsapp.net",
      displayName: "Papa (newer)",
      candidates: [existing],
      scores: { [existing]: 0.99 },
      ladder: { model: MODEL },
    });
    // A different mint, so the stored `different` does not apply — it binds.
    expect(res.escalations[0].outcome).toBe("merged");
    // …and the ORIGINAL negative pair is still standing.
    expect(isNegativePair(existing, minted.bind.entityId)).toBe(true);
  });
});

describe("zero silent guesses", () => {
  it("refuses a bind with no decider or no confidence", () => {
    expect(() => assertProvenance("", 1)).toThrow(/decided_by/);
    expect(() => assertProvenance("ml:entity_name", null)).toThrow(/confidence/);
    expect(() => assertProvenance("ml:entity_name", Number.NaN)).toThrow(/confidence/);
    expect(() => assertProvenance("ml:entity_name", 0)).not.toThrow();
  });
});
