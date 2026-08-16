// ===========================================================================
// The stream-roster stage — the caller `bindGroupParticipants` never had.
//
// What is tested is the WIRING and the two writes it owes, not the binder
// (`entities/binding.test.ts` owns that): that a group lane produces
// `affiliated_with:member` edges AND a non-NULL `streams.participant_entity_ids`,
// that a 1:1 lane gets the roster and no membership, that a re-run writes no
// duplicate of either, that an install whose events were bound BEFORE this file
// existed is repaired without a queue row — and that the whole pass bills
// nothing, which is asserted against the `runs` ledger and not against the
// report's own claim about itself.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, setSelfIdentity, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { meEntityId } from "../entities/binding.js";
import { edgesFrom, edgesTo, listEdges } from "../entities/edges.js";
import { countEntities, getEntity } from "../entities/registry.js";
import { entityPass, identityKindOf } from "./entity-pass.js";
import { bindStreamParticipants, pendingStreamRosters } from "./stream-participants.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const SELF_JID = "919731006976@s.whatsapp.net";
const GROUP_JID = "120363111222333@g.us";
const RAHUL = "919000000001@s.whatsapp.net";
const PRIYA = "919000000002@s.whatsapp.net";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-stream-roster-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  setSelfIdentity("whatsapp", SELF_JID);
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stream(extId: string, kind: string, label: string): string {
  return upsertStream({ sourceId: "whatsapp", sourceExtId: extId, name: label, kind });
}

/** One line from `jid` in `streamId`, queued at stage `entity` by `entityPass`. */
function speak(streamId: string, jid: string, name: string, seq: number): string {
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: jid, displayName: name, handle: null });
  return insertEvent({
    externalId: `${streamId}-${jid}-${seq}`,
    sourceId: "whatsapp",
    sourceType: "whatsapp",
    streamId,
    actorId: actor,
    ts: new Date(NOW - (100 - seq) * 60_000).toISOString(),
    kind: "message",
    text: `line ${seq}`,
    mediaPath: null,
    rawJson: null,
    isHistorical: true,
  }).id;
}

function rosterOf(streamId: string): string[] | null {
  const row = getDb().prepare(`SELECT participant_entity_ids AS p FROM streams WHERE id = ?`).get(streamId) as
    | { p: string | null }
    | undefined;
  return row?.p === null || row?.p === undefined ? null : (JSON.parse(row.p) as string[]);
}

function edgeCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM entity_edges`).get() as { n: number }).n;
}

function runsCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
}

/** The entity every event of this actor was bound to. */
function entityOfActor(jid: string): string {
  const row = getDb()
    .prepare(
      `SELECT e.actor_entity_id AS id FROM events e JOIN actors a ON a.id = e.actor_id
        WHERE a.source_ext_id = ? AND e.actor_entity_id IS NOT NULL LIMIT 1`,
    )
    .get(jid) as { id: string } | undefined;
  expect(row?.id).toBeTruthy();
  return row!.id;
}

// ---------------------------------------------------------------------------

describe("a group lane", () => {
  function buildGroup(): string {
    const g = stream(GROUP_JID, "group", "Ghar+");
    speak(g, SELF_JID, "Aditya Katare", 1);
    speak(g, RAHUL, "Rahul", 2);
    speak(g, PRIYA, "Priya", 3);
    speak(g, RAHUL, "Rahul", 4);
    return g;
  }

  it("writes a member edge per participant and a non-NULL roster", () => {
    const g = buildGroup();
    const report = entityPass({ now: NOW, limit: 100 });

    expect(report.rosters.streams).toBe(1);
    expect(report.rosters.groups).toBe(1);
    expect(report.errors).toEqual([]);

    // The roster is exactly the three bound speakers, deduped and sorted.
    const roster = rosterOf(g);
    expect(roster).not.toBeNull();
    expect(roster).toEqual([entityOfActor(SELF_JID), entityOfActor(RAHUL), entityOfActor(PRIYA)].sort());

    // The container is a real `group` entity carrying the lane's human label,
    // not the jid — and every member points at it.
    const members = listEdges({ kind: "affiliated_with", subtype: "member", status: "active" });
    expect(members).toHaveLength(3);
    const containers = new Set(members.map((e) => e.dstEntityId));
    expect(containers.size).toBe(1);
    const group = getEntity([...containers][0]);
    expect(group?.type).toBe("group");
    expect(group?.canonical).toBe("Ghar+");
    expect(new Set(members.map((e) => e.srcEntityId))).toEqual(new Set(roster));
    for (const edge of members) {
      expect(edge.confidence).toBe(1);
      expect(edge.decidedBy).toBe("code:metadata");
    }
  });

  it("gives `me` the self edge arc promotion reads", () => {
    buildGroup();
    entityPass({ now: NOW, limit: 100 });

    // `arcs/promote-store.ts`'s `readSelfEdges` is a `src_entity_id = me AND
    // status = 'active'` over the reference kinds. Before this stage it read 0
    // rows on every install.
    const me = meEntityId();
    expect(me).not.toBeNull();
    const mine = edgesFrom(me!, { kind: "affiliated_with", subtype: "member", status: "active" });
    expect(mine).toHaveLength(1);
    expect(getEntity(mine[0].dstEntityId)?.type).toBe("group");
  });

  it("dates the membership from the FIRST line, not the last", () => {
    const g = buildGroup();
    entityPass({ now: NOW, limit: 100 });
    const first = (
      getDb().prepare(`SELECT MIN(ts) AS ts FROM events WHERE stream_id = ?`).get(g) as { ts: string }
    ).ts;
    for (const edge of listEdges({ kind: "affiliated_with" })) expect(edge.validFrom).toBe(first);
  });

  it("is idempotent — a re-run writes no second edge and no second roster entry", () => {
    buildGroup();
    entityPass({ now: NOW, limit: 100 });
    const edges = edgeCount();
    const entities = countEntities();
    const roster = rosterOf(stream(GROUP_JID, "group", "Ghar+"));

    // Nothing is pending once the roster matches the events — the queue-free
    // pending query is what makes the second call a no-op.
    expect(pendingStreamRosters()).toEqual([]);

    const second = entityPass({ now: NOW, limit: 100 });
    expect(second.rosters.streams).toBe(0);
    expect(edgeCount()).toBe(edges);
    expect(countEntities()).toBe(entities);
    expect(rosterOf(stream(GROUP_JID, "group", "Ghar+"))).toEqual(roster);

    // …and even a FORCED sweep converges: the pending query is an optimisation,
    // the writes underneath it are upserts.
    const forced = bindStreamParticipants({ kindOf: identityKindOf });
    expect(forced.streams).toBe(0);
    expect(edgeCount()).toBe(edges);
  });
});

describe("a 1:1 lane", () => {
  it("gets a roster and no membership — a dm is not a group to be a member of", () => {
    const dm = stream("919000000001@s.whatsapp.net", "dm", "Rahul");
    speak(dm, SELF_JID, "Aditya Katare", 1);
    speak(dm, RAHUL, "Rahul", 2);

    const report = entityPass({ now: NOW, limit: 100 });
    expect(report.rosters.streams).toBe(1);
    expect(report.rosters.groups).toBe(0);
    expect(rosterOf(dm)).toEqual([entityOfActor(SELF_JID), entityOfActor(RAHUL)].sort());
    expect(listEdges()).toEqual([]);
    // No group entity was minted behind the lane's back either.
    expect(edgesTo(entityOfActor(RAHUL))).toEqual([]);
  });
});

describe("the repair path", () => {
  it("fills a roster for events that were bound before this stage existed", () => {
    const g = stream(GROUP_JID, "group", "Ghar+");
    speak(g, SELF_JID, "Aditya Katare", 1);
    speak(g, RAHUL, "Rahul", 2);
    entityPass({ now: NOW, limit: 100 });

    // Rewind the two writes this stage owns, leaving `actor_entity_id` exactly
    // as a live install has it: bound events, an empty graph.
    getDb().prepare(`UPDATE streams SET participant_entity_ids = NULL`).run();
    getDb().prepare(`DELETE FROM entity_edges`).run();
    expect(pendingStreamRosters()).toEqual([g]);

    // The drain claims NOTHING — every event is already bound — and the roster
    // is still repaired. That is the whole reason the sweep is not gated on it.
    const report = entityPass({ now: NOW, limit: 100 });
    expect(report.claimed).toBe(0);
    expect(report.rosters.streams).toBe(1);
    expect(rosterOf(g)).toHaveLength(2);
    expect(edgeCount()).toBe(2);
  });

  it("leaves a stream with no bound actor alone rather than inventing a roster", () => {
    const g = stream(GROUP_JID, "group", "Ghar+");
    speak(g, RAHUL, "Rahul", 1);
    getDb().prepare(`UPDATE events SET actor_entity_id = NULL`).run();

    const report = bindStreamParticipants({ kindOf: identityKindOf });
    expect(report.streams).toBe(0);
    expect(rosterOf(g)).toBeNull();
    expect(listEdges()).toEqual([]);
  });
});

describe("the cost guarantee", () => {
  it("bills nothing — asserted against the `runs` ledger, not the report", () => {
    const g = stream(GROUP_JID, "group", "Ghar+");
    const dm = stream("919000000002@s.whatsapp.net", "dm", "Priya");
    speak(g, SELF_JID, "Aditya Katare", 1);
    speak(g, RAHUL, "Rahul", 2);
    speak(g, PRIYA, "Priya", 3);
    speak(dm, PRIYA, "Priya", 4);

    const report = entityPass({ now: NOW, limit: 100 });
    expect(report.rosters.streams).toBe(2);
    expect(report.rosters.groups).toBe(1);
    expect(report.rosters.llmCalls).toBe(0);
    // The ledger is the thing that cannot lie: a provider call writes a `runs`
    // row, so zero rows is zero calls no matter what any report says.
    expect(runsCount()).toBe(0);
  });
});
