// ===========================================================================
// Merges, splits and negative pairs (build item 1.5, arch §10.3; evals G).
//
// The round trip is the headline: merge B into A, read B and land on A, split,
// and get two entities back with their own identities — because a merge that
// cannot be undone is a merge nobody should be allowed to make automatically.
//
// The other half is the permanence of "different". A user's `different` beats
// any later automation score, at any confidence. That rule is enforced in
// `recordDecision` and in `mergeEntities`, and both are tested here.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb } from "../db/connection.js";
import { SELF_ENTITY_ID } from "../db/v6graph.js";
import { runMigrations } from "../db/index.js";
import { identitiesOf, putIdentity } from "./identities.js";
import {
  compactMerges,
  isNegativePair,
  listDecisions,
  mayPropose,
  mergeEntities,
  mutationsFor,
  openResolutionQuestions,
  queueResolution,
  readDecision,
  recordDecision,
  splitEntity,
  tombstoneCount,
} from "./merge.js";
import { createEntity, getEntity, listEntities, readEntityRaw, resolveEntityId } from "./registry.js";

/** Every live entity except the self row 0201_v6_graph seeds on a fresh db. */
function others() {
  return listEntities().filter((e) => e.id !== SELF_ENTITY_ID);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-ent-merge-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** "Papa" and "Papa (new number Jio)", each with its own source identity. */
function twoPapas(): { winner: string; loser: string } {
  const winner = createEntity({ type: "person", canonical: "Papa" });
  const loser = createEntity({ type: "person", canonical: "Papa (new number Jio)" });
  putIdentity({
    entityId: winner.id,
    sourceId: "whatsapp",
    kind: "jid",
    value: "919425000007@s.whatsapp.net",
    confidence: 1,
    decidedBy: "code:mint",
  });
  putIdentity({
    entityId: loser.id,
    sourceId: "contacts",
    kind: "phone",
    value: "+919812000021",
    confidence: 1,
    decidedBy: "code:mint",
  });
  return { winner: winner.id, loser: loser.id };
}

describe("tombstone merges", () => {
  it("redirects reads and leaves one live entity", () => {
    const { winner, loser } = twoPapas();
    const res = mergeEntities({ loser, winner, actor: "agent:p-ag1", reason: "same group, old number silent" });
    expect(res.merged).toBe(true);
    expect(resolveEntityId(loser)).toBe(winner);
    expect(getEntity(loser)?.id).toBe(winner);
    expect(others().map((e) => e.id)).toEqual([winner]);
    expect(tombstoneCount(winner)).toBe(1);
    // Identities are NOT rewritten — that is what keeps the merge O(1).
    expect(identitiesOf(winner).map((i) => i.kind).sort()).toEqual(["jid", "phone"]);
  });

  it("logs a mutation and a `same` decision", () => {
    const { winner, loser } = twoPapas();
    mergeEntities({ loser, winner, actor: "user", reason: "it's him" });
    const muts = mutationsFor("entity", loser);
    expect(muts).toHaveLength(1);
    expect(muts[0].field).toBe("merged_into");
    expect(muts[0].newValue).toBe(winner);
    expect(readDecision(loser, winner)?.verdict).toBe("same");
  });

  it("keeps chains one hop deep", () => {
    const a = createEntity({ type: "person" }).id;
    const b = createEntity({ type: "person" }).id;
    const c = createEntity({ type: "person" }).id;
    mergeEntities({ loser: c, winner: b, actor: "user" });
    mergeEntities({ loser: b, winner: a, actor: "user" });
    expect(readEntityRaw(c)?.mergedInto).toBe(a);
    expect(resolveEntityId(c)).toBe(a);
  });

  it("refuses to merge an entity into itself", () => {
    const a = createEntity({ type: "person" }).id;
    expect(mergeEntities({ loser: a, winner: a, actor: "user" }).refused).toBe("same_entity");
  });
});

describe("split — the round trip", () => {
  it("restores both entities with their own identities", () => {
    const { winner, loser } = twoPapas();
    mergeEntities({ loser, winner, actor: "agent:p-ag1" });
    const res = splitEntity({ entityId: loser, actor: "user", reason: "wrong merge" });

    expect(res.split).toBe(true);
    expect(res.from).toBe(winner);
    expect(resolveEntityId(loser)).toBe(loser);
    expect(others().map((e) => e.id).sort()).toEqual([winner, loser].sort());
    expect(identitiesOf(loser).map((i) => i.valueNorm)).toEqual(["+919812000021"]);
    expect(identitiesOf(winner).map((i) => i.valueNorm)).toEqual(["919425000007@s.whatsapp.net"]);
  });

  it("re-points by source identity after reconcile has compacted the merge", () => {
    const { winner, loser } = twoPapas();
    mergeEntities({ loser, winner, actor: "agent:p-ag1" });
    expect(compactMerges()).toBe(1);
    // Compacted: everything now hangs off the winner.
    expect(identitiesOf(winner)).toHaveLength(2);

    const res = splitEntity({ entityId: loser, actor: "user" });
    expect(res.identitiesRestored).toBe(1);
    expect(identitiesOf(loser).map((i) => i.valueNorm)).toEqual(["+919812000021"]);
    expect(identitiesOf(winner).map((i) => i.valueNorm)).toEqual(["919425000007@s.whatsapp.net"]);
  });

  it("logs the split and records the pair as different", () => {
    const { winner, loser } = twoPapas();
    mergeEntities({ loser, winner, actor: "agent:p-ag1" });
    splitEntity({ entityId: loser, actor: "user", reason: "not the same person" });
    expect(mutationsFor("entity", loser).map((m) => m.newValue)).toEqual([winner, null]);
    expect(isNegativePair(loser, winner)).toBe(true);
  });

  it("is a no-op on an entity that was never merged", () => {
    const a = createEntity({ type: "person" }).id;
    expect(splitEntity({ entityId: a, actor: "user" }).split).toBe(false);
  });
});

describe("negative pairs are permanent", () => {
  it("blocks the merge, forever", () => {
    const a = createEntity({ type: "person", canonical: "Rahul Arora" }).id;
    const b = createEntity({ type: "person", canonical: "Rahul Mehta" }).id;
    recordDecision({ left: a, right: b, verdict: "different", decidedBy: "user", reason: "different people" });

    expect(mayPropose(a, b)).toBe(false);
    const res = mergeEntities({ loser: b, winner: a, actor: "ml:entity_name" });
    expect(res.merged).toBe(false);
    expect(res.refused).toBe("negative_pair");
    expect(others()).toHaveLength(2);
  });

  it("a user verdict outranks any later automation score", () => {
    const a = createEntity({ type: "person" }).id;
    const b = createEntity({ type: "person" }).id;
    recordDecision({ left: a, right: b, verdict: "different", decidedBy: "user" });
    recordDecision({ left: b, right: a, verdict: "same", decidedBy: "ml:entity_name", reason: "score 0.93" });
    expect(readDecision(a, b)?.verdict).toBe("different");
    expect(readDecision(a, b)?.decidedBy).toBe("user");
  });

  it("stores a pair once, whichever way round it is asked", () => {
    const a = createEntity({ type: "person" }).id;
    const b = createEntity({ type: "person" }).id;
    recordDecision({ left: a, right: b, verdict: "unsure", decidedBy: "agent:p-ag1" });
    recordDecision({ left: b, right: a, verdict: "different", decidedBy: "user" });
    expect(listDecisions()).toHaveLength(1);
    expect(readDecision(a, b)?.verdict).toBe("different");
  });
});

describe("the resolution queue", () => {
  it("asks rather than binds, and never auto-retries", () => {
    const a = createEntity({ type: "person", canonical: "Amit (gym)" }).id;
    const b = createEntity({ type: "person", canonical: "Amit (office)" }).id;
    queueResolution({ left: a, right: b, question: "Are these the same Amit?", reason: "ml:in_band" });

    const open = openResolutionQuestions();
    expect(open).toHaveLength(1);
    expect(open[0].question).toBe("Are these the same Amit?");
    // In-band means unsure, and unsure is not a bind.
    expect(readDecision(a, b)?.verdict).toBe("unsure");
    expect(others()).toHaveLength(2);
  });
});
