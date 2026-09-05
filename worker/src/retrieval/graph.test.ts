// ===========================================================================
// Graph retrieval — the bounded BFS walk (V6 P1 S2.6; Build §5.2).
//
//   RET-09  graph walk with hub exclusion. Seeds: Ma. `jasmine tea` (prefers)
//           and `Diwali gifts` (via ep_882) within 2 hops; `self` excluded;
//           fan-out capped. Wrong: `hub-walk` — half the graph through self.
//
// Plus the mechanics the fixture leans on: decay 0.6 per hop × confidence ×
// recency, status/validity pruning, the fan-out cap, seeds from chunk hits,
// determinism. Zero model calls.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appendEvent, type EventEnvelope } from "../db/eventlog.js";
import { addEpisodeEvents } from "../db/v6core.js";
import { addHub, SELF_ENTITY_ID, type ChunkRow } from "../db/v6graph.js";
import { METADATA_DECIDER, rejectEdge, supersedeEdge, writeEdge } from "../entities/edges.js";
import { writeMention } from "../entities/mentions.js";
import { createEntity } from "../entities/registry.js";
import { writeClaimVersion } from "../claims/store.js";
import {
  GRAPH_DEFAULTS,
  graphRetrieve,
  graphWalk,
  nodeKey,
  parseNodeKey,
  recencyWeight,
  seedsFromHits,
  type GraphHit,
} from "./graph.js";

const NOW = "2026-09-06T12:00:00.000Z";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-graph-walk-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function event(text: string, overrides: Partial<EventEnvelope> = {}): string {
  seq += 1;
  const { id } = appendEvent(
    {
      ts: NOW,
      source: "wa",
      kind: "wa.message",
      origin: "live",
      streamKey: "ma@s.whatsapp.net",
      actor: "contact:ma",
      roles: { sender: "contact:ma", audience: ["self"], receiver: ["*audience"], mentions: [] },
      payload: { text: `${text} #${seq}` },
      ...overrides,
    },
    Date.parse(NOW),
  );
  return id;
}

function episode(id: string, summary: string, eventIds: string[], lastTs = NOW): string {
  getDb()
    .prepare(`INSERT INTO episodes (id, state, summary, first_ts, last_ts) VALUES (?, 'open', ?, ?, ?)`)
    .run(id, summary, lastTs, lastTs);
  addEpisodeEvents(id, eventIds, "test");
  return id;
}

function person(name: string): string {
  return createEntity({ type: "person", canonical: name, provisional: false }).id;
}

function byKey(hits: GraphHit[]): Map<string, GraphHit> {
  return new Map(hits.map((h) => [h.key, h]));
}

/** The RET-09 world. Returns the ids the assertions need. */
function seedRet09(): { ma: string; diwali: string; ep882: string; others: string[]; claimKey: string } {
  const ma = person("Ma");
  const diwali = createEntity({ type: "topic", canonical: "Diwali gifts", provisional: false }).id;

  // Ma ── related_to:mother ──► self (the seeded hub).
  writeEdge({ kind: "related_to", subtype: "mother", srcEntityId: ma, dstEntityId: SELF_ENTITY_ID, decidedBy: METADATA_DECIDER });

  // Half the graph hangs off self and off nothing else — the hub-walk bait.
  const others: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const id = person(`Acquaintance ${i}`);
    others.push(id);
    writeEdge({ kind: "related_to", subtype: "friend", srcEntityId: SELF_ENTITY_ID, dstEntityId: id, decidedBy: METADATA_DECIDER });
  }

  // ep_882: Ma is mentioned in one member event, Diwali gifts in another.
  const e1 = event("Ma: beta, what are we doing for Diwali this year");
  const e2 = event("self: thinking about Diwali gifts for everyone");
  const ep882 = episode("ep_882", "Diwali plans with Ma", [e1, e2]);
  writeMention({ eventId: e1, entityId: ma, surfaceText: "Ma", decidedBy: "test" });
  writeMention({ eventId: e2, entityId: diwali, surfaceText: "Diwali gifts", decidedBy: "test" });
  // self is mentioned in ep_882 too — and must never be walked into.
  writeMention({ eventId: e2, entityId: SELF_ENTITY_ID, surfaceText: "self", decidedBy: "test" });

  // Ma prefers jasmine tea — a preference claim, subject Ma.
  const e3 = event("Ma: only jasmine tea for me please");
  const claimKey = "clm_ma_prefers_jasmine";
  writeClaimVersion({
    claimKey,
    kind: "preference",
    subjectId: ma,
    predicate: "prefers",
    object: "jasmine tea",
    text: "Ma prefers jasmine tea",
    confidence: 0.9,
    statedAt: NOW,
    evidence: [{ event_ids: [e3], quote: "only jasmine tea for me please" }],
    decidedBy: "test",
  });

  return { ma, diwali, ep882, others, claimKey };
}

describe("RET-09 — graph walk with hub exclusion", () => {
  it("seeds Ma: jasmine tea (prefers) and Diwali gifts (via ep_882) within 2 hops, self excluded", () => {
    const w = seedRet09();
    const r = graphWalk([{ kind: "entity", id: w.ma }], { now: NOW });
    const hits = byKey(r.hits);

    // jasmine tea via the preference claim — the `prefers` edge.
    const tea = hits.get(nodeKey({ kind: "claim", id: w.claimKey }));
    expect(tea).toBeDefined();
    expect(tea!.hop).toBeLessThanOrEqual(2);
    expect(tea!.label).toContain("jasmine tea");
    expect(tea!.path.map((s) => s.edge)).toEqual(["claim:preference"]);

    // Diwali gifts via ep_882 at hop 2: Ma ─mentioned_in─► ep_882 ─about─► Diwali gifts.
    const ep = hits.get(nodeKey({ kind: "episode", id: w.ep882 }));
    expect(ep).toBeDefined();
    expect(ep!.hop).toBe(1);
    expect(ep!.path.map((s) => s.edge)).toEqual(["mentioned_in"]);
    const diwali = hits.get(nodeKey({ kind: "entity", id: w.diwali }));
    expect(diwali).toBeDefined();
    expect(diwali!.hop).toBe(2);
    expect(diwali!.label).toBe("Diwali gifts");
    expect(diwali!.path.map((s) => s.edge)).toEqual(["mentioned_in", "about"]);
    expect(diwali!.path[1]!.from).toEqual({ kind: "episode", id: w.ep882 });

    // self is a hub: never entered, never a hit — through the edge OR the mention.
    expect(hits.has(nodeKey({ kind: "entity", id: SELF_ENTITY_ID }))).toBe(false);
    expect(r.pruned.hubs).toBeGreaterThan(0);

    // Wrong: `hub-walk` — none of the 12 acquaintances hanging off self appear.
    for (const id of w.others) expect(hits.has(nodeKey({ kind: "entity", id }))).toBe(false);
    // Seeds are never hits.
    expect(hits.has(nodeKey({ kind: "entity", id: w.ma }))).toBe(false);
  });

  it("score = decay × confidence × recency, per hop", () => {
    const w = seedRet09();
    const r = graphWalk([{ kind: "entity", id: w.ma }], { now: NOW });
    const hits = byKey(r.hits);
    // Evidence is at NOW → recency 1. ep_882: 1 × 0.6 × 1 = 0.6; Diwali: 0.6 × 0.6 × 1 = 0.36.
    expect(hits.get(`episode:${w.ep882}`)!.score).toBeCloseTo(0.6, 6);
    expect(hits.get(`entity:${w.diwali}`)!.score).toBeCloseTo(0.36, 6);
    // The claim carries its own confidence: 0.6 × 0.9.
    expect(hits.get(`claim:${w.claimKey}`)!.score).toBeCloseTo(0.54, 6);
    // Best first.
    const scores = r.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("a seed that is itself a hub is dropped, not expanded", () => {
    seedRet09();
    const r = graphWalk([{ kind: "entity", id: SELF_ENTITY_ID }], { now: NOW });
    expect(r.seeds).toEqual([]);
    expect(r.hits).toEqual([]);
    expect(r.expanded).toBe(0);
    expect(r.pruned.hubs).toBe(1);
  });

  it("a degree hub added by code is excluded the same way as self", () => {
    const w = seedRet09();
    // Make ep_882's Diwali entity a hub: the walk must no longer enter it.
    addHub(w.diwali, "degree", { degree: 999 });
    const r = graphWalk([{ kind: "entity", id: w.ma }], { now: NOW });
    expect(byKey(r.hits).has(`entity:${w.diwali}`)).toBe(false);
  });
});

describe("fan-out cap", () => {
  it("expands only the top-N edges of a node by confidence", () => {
    const ma = person("Ma");
    const friends: { id: string; conf: number }[] = [];
    for (let i = 0; i < 30; i += 1) {
      const id = person(`Friend ${String(i).padStart(2, "0")}`);
      const conf = 0.99 - i * 0.01;
      friends.push({ id, conf });
      writeEdge({ kind: "related_to", subtype: "friend", srcEntityId: ma, dstEntityId: id, decidedBy: METADATA_DECIDER, confidence: conf });
    }
    const r = graphWalk([{ kind: "entity", id: ma }], { now: NOW, fanOut: 5, maxHops: 1 });
    expect(r.hits).toHaveLength(5);
    const top5 = friends.slice(0, 5).map((f) => `entity:${f.id}`).sort();
    expect(r.hits.map((h) => h.key).sort()).toEqual(top5);
    expect(r.edgesRead).toBe(5);
  });

  it("the default cap is 20 and the default walk is 2 hops at decay 0.6", () => {
    expect(GRAPH_DEFAULTS.fanOut).toBe(20);
    expect(GRAPH_DEFAULTS.maxHops).toBe(2);
    expect(GRAPH_DEFAULTS.decay).toBe(0.6);
  });
});

describe("status and validity pruning", () => {
  it("superseded, rejected and expired edges are not walked", () => {
    const ma = person("Ma");
    const oldHome = createEntity({ type: "place", canonical: "Old flat", provisional: false }).id;
    const newHome = createEntity({ type: "place", canonical: "New flat", provisional: false }).id;
    const exFriend = person("Ex friend");
    const future = person("Future colleague");

    // A move: the old located_at:current is superseded (valid_to set) by the new one.
    writeEdge({ kind: "located_at", subtype: "current", srcEntityId: ma, dstEntityId: oldHome, decidedBy: METADATA_DECIDER });
    writeEdge({ kind: "located_at", subtype: "current", srcEntityId: ma, dstEntityId: newHome, decidedBy: METADATA_DECIDER, validFrom: "2026-01-01T00:00:00Z" });
    // A rejected edge.
    const rej = writeEdge({ kind: "related_to", subtype: "friend", srcEntityId: ma, dstEntityId: exFriend, decidedBy: METADATA_DECIDER });
    rejectEdge(rej.edge.id);
    // An edge that only becomes valid after `now`.
    writeEdge({ kind: "related_to", subtype: "colleague", srcEntityId: ma, dstEntityId: future, decidedBy: METADATA_DECIDER, validFrom: "2027-01-01T00:00:00Z" });

    const r = graphWalk([{ kind: "entity", id: ma }], { now: NOW, maxHops: 1 });
    const keys = r.hits.map((h) => h.key);
    expect(keys).toEqual([`entity:${newHome}`]);
    expect(r.hits[0]!.path[0]!.edge).toBe("located_at:current");

    // Explicit supersede of the survivor: nothing left to walk.
    const live = getDb().prepare(`SELECT id FROM entity_edges WHERE dst_entity_id = ? AND status = 'active'`).get(newHome) as { id: string };
    supersedeEdge(live.id, { validTo: "2026-06-01T00:00:00Z" });
    expect(graphWalk([{ kind: "entity", id: ma }], { now: NOW, maxHops: 1 }).hits).toEqual([]);
  });

  it("closed claims and claims with an ended validity are not walked", () => {
    const ma = person("Ma");
    const e = event("Ma: I used to love chai");
    writeClaimVersion({
      claimKey: "clm_old",
      kind: "preference",
      subjectId: ma,
      text: "Ma prefers chai",
      confidence: 0.9,
      statedAt: "2020-01-01T00:00:00Z",
      validTo: "2021-01-01T00:00:00Z",
      evidence: [{ event_ids: [e], quote: "I used to love chai" }],
      decidedBy: "test",
    });
    writeClaimVersion({
      claimKey: "clm_closed",
      kind: "habit",
      subjectId: ma,
      text: "Ma walks at 6",
      confidence: 0.9,
      statedAt: NOW,
      evidence: [{ event_ids: [e], quote: "walks at 6" }],
      decidedBy: "test",
    });
    getDb().prepare(`UPDATE claims SET status = 'closed' WHERE claim_key = 'clm_closed'`).run();
    const r = graphWalk([{ kind: "entity", id: ma }], { now: NOW, maxHops: 1 });
    expect(r.hits).toEqual([]);
  });

  it("minScore prunes deep, weak paths", () => {
    const w = seedRet09();
    const r = graphWalk([{ kind: "entity", id: w.ma }], { now: NOW, minScore: 0.55 });
    // Only hop-1 edges at confidence 1 survive (0.6); the 0.54 claim and the 0.36 hop-2 do not.
    expect(r.hits.map((h) => h.key)).toEqual([`episode:${w.ep882}`]);
    expect(r.pruned.score).toBeGreaterThan(0);
  });
});

describe("recency", () => {
  it("halves per half-life, floors at 0.25, and treats unknown or future ts as 1", () => {
    expect(recencyWeight(null, NOW)).toBe(1);
    expect(recencyWeight("2027-01-01T00:00:00Z", NOW)).toBe(1);
    expect(recencyWeight("2025-09-06T12:00:00.000Z", NOW, 365)).toBeCloseTo(0.5, 6);
    expect(recencyWeight("2000-01-01T00:00:00Z", NOW)).toBe(GRAPH_DEFAULTS.recencyFloor);
    expect(recencyWeight("garbage", NOW)).toBe(1);
  });

  it("older evidence ranks below fresher evidence at the same confidence", () => {
    const ma = person("Ma");
    const recent = person("Recent");
    const stale = person("Stale");
    const eNew = event("Ma with Recent", { ts: NOW });
    const eOld = event("Ma with Stale", { ts: "2023-09-06T12:00:00.000Z" });
    writeEdge({ kind: "related_to", subtype: "friend", srcEntityId: ma, dstEntityId: recent, decidedBy: "llm:extract", quote: "Ma with Recent", eventId: eNew, confidence: 0.8 });
    writeEdge({ kind: "related_to", subtype: "friend", srcEntityId: ma, dstEntityId: stale, decidedBy: "llm:extract", quote: "Ma with Stale", eventId: eOld, confidence: 0.8 });
    const r = graphWalk([{ kind: "entity", id: ma }], { now: NOW, maxHops: 1 });
    expect(r.hits.map((h) => h.key)).toEqual([`entity:${recent}`, `entity:${stale}`]);
    expect(r.hits[0]!.score).toBeCloseTo(0.6 * 0.8, 6);
    expect(r.hits[1]!.score).toBeCloseTo(0.6 * 0.8 * 0.25, 6);
  });
});

describe("seeds from lexical + vector", () => {
  it("chunks seed their events or their card refs; ids dedupe; merged entities resolve", () => {
    const ma = person("Ma");
    const alias = person("Mummy");
    getDb().prepare(`UPDATE entities SET merged_into = ? WHERE id = ?`).run(ma, alias);
    const chunk = (kind: ChunkRow["kind"], refId: string | null, eventIds: string[]): ChunkRow => ({
      id: 0, kind, source: null, streamKey: null, refId, seq: 0, text: "", textLen: 0, contentHash: "",
      tsStart: null, tsEnd: null, eventIds, tier: null, consentId: null, createdAt: NOW, updatedAt: NOW,
    });
    const seeds = seedsFromHits({
      entityIds: [alias, ma],
      eventIds: ["ev_1"],
      chunks: [chunk("chat", null, ["ev_1", "ev_2"]), chunk("person", alias, []), chunk("episode", "ep_9", []), chunk("claim", "clm_1", [])],
    });
    expect(seeds).toEqual([
      { kind: "entity", id: ma },
      { kind: "event", id: "ev_1" },
      { kind: "event", id: "ev_2" },
      { kind: "episode", id: "ep_9" },
      { kind: "claim", id: "clm_1" },
    ]);
  });

  it("graphRetrieve = seeds + walk; the walk is deterministic for a fixed now", () => {
    const w = seedRet09();
    const a = graphRetrieve({ entityIds: [w.ma] }, { now: NOW });
    const b = graphRetrieve({ entityIds: [w.ma] }, { now: NOW });
    expect(a.hits.map((h) => [h.key, h.hop, h.score])).toEqual(b.hits.map((h) => [h.key, h.hop, h.score]));
    expect(a.hits.length).toBeGreaterThan(0);
  });

  it("node keys round-trip", () => {
    expect(parseNodeKey(nodeKey({ kind: "episode", id: "ep_882" }))).toEqual({ kind: "episode", id: "ep_882" });
    expect(parseNodeKey("space:sp_1")).toBeNull();
    expect(parseNodeKey("entity:")).toBeNull();
  });

  it("an event seed reaches its episode and the entities it mentions", () => {
    const ma = person("Ma");
    const e = event("Ma: chai?");
    const ep = episode("ep_1", "Chai", [e]);
    writeMention({ eventId: e, entityId: ma, decidedBy: "test" });
    writeMention({ eventId: e, entityId: SELF_ENTITY_ID, decidedBy: "test" });
    const r = graphWalk([{ kind: "event", id: e }], { now: NOW, maxHops: 1 });
    expect(r.hits.map((h) => h.key).sort()).toEqual([`entity:${ma}`, `episode:${ep}`].sort());
  });
});
