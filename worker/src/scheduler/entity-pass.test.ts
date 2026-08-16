// ===========================================================================
// The entity stage — the drainer the `entity` queue never had.
//
// What is tested is the WIRING, not the ladder (`entities/*.test.ts` owns
// that): that a backlog of events reduces to a bounded set of actor binds,
// that `me` binds from `app_state` on the very first pass, that a re-run does
// not mint a second anybody, that a crash mid-drain is resumable, that an
// in-band pair is PARKED rather than adjudicated — and that the whole pass
// bills nothing, which is asserted against the `runs` ledger and not merely
// against the report's own claim about itself.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, setSelfIdentity, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { AgentBatch } from "../entities/adjudicate.js";
import { meEntityId } from "../entities/binding.js";
import { identitiesOf } from "../entities/identities.js";
import { countEntities, createEntity, listEntities } from "../entities/registry.js";
import { resumeQueue } from "./queue.js";
import {
  bindSelfIdentities,
  drainEntityQueue,
  emptyEntityReport,
  enqueueEntityWork,
  entityPass,
  identityKindOf,
  pendingEntityWork,
  resolveActorEntity,
} from "./entity-pass.js";

const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const SELF_JID = "919731006976@s.whatsapp.net";

let tmpDir: string;
let C1 = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-entity-pass-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: "whatsapp", type: "whatsapp", name: "WhatsApp" });
  C1 = upsertStream({ sourceId: "whatsapp", sourceExtId: "c1", name: "Pranjali", kind: "dm" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

/** `n` events from one actor, queued at stage `entity` the way rescan does it. */
function speak(jid: string, name: string, n: number, opts: { streamId?: string } = {}): string[] {
  const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: jid, displayName: name, handle: null });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(
      insertEvent({
        externalId: `${jid}-${i}`,
        sourceId: "whatsapp",
        sourceType: "whatsapp",
        streamId: opts.streamId ?? C1,
        actorId: actor,
        ts: new Date(NOW - (n - i) * 60_000).toISOString(),
        kind: "message",
        text: `line ${i}`,
        mediaPath: null,
        rawJson: null,
        isHistorical: true,
      }).id,
    );
  }
  return ids;
}

/** The row id `tiers/rescan.ts` actually writes — deliberately NOT `workId()`. */
function rescanEnqueue(eventIds: readonly string[], priority = 100): void {
  const insert = getDb().prepare(
    `INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state)
     VALUES (?, 'event', ?, NULL, 'entity', ?, 'ready')
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const id of eventIds) insert.run(`wq:entity:${id}`, id, priority);
}

function actorEntityIds(): (string | null)[] {
  return (
    getDb().prepare(`SELECT actor_entity_id AS e FROM events ORDER BY id`).all() as { e: string | null }[]
  ).map((r) => r.e);
}

function runsCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;
}

function stateOfQueue(): Record<string, number> {
  const rows = getDb().prepare(`SELECT state, COUNT(*) AS n FROM work_queue GROUP BY state`).all() as {
    state: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

// ---------------------------------------------------------------------------

describe("identityKindOf", () => {
  it("reads the kind off the value's own shape", () => {
    expect(identityKindOf("whatsapp", SELF_JID)).toBe("jid");
    expect(identityKindOf("whatsapp", "12036@g.us")).toBe("jid");
    expect(identityKindOf("calendar", "aditya@example.com")).toBe("email");
    expect(identityKindOf("contacts", "+919731006976")).toBe("phone");
  });

  it("falls to `handle` for an unrecognised shape — a handle never binds cross-source", () => {
    expect(identityKindOf("slack", "U0123ABC")).toBe("handle");
    expect(identityKindOf(null, "rahul")).toBe("handle");
  });
});

describe("bindSelfIdentities", () => {
  it("binds `me` from app_state on the very first pass — no adapter registered", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    const bound = bindSelfIdentities();
    expect(bound).toHaveLength(1);
    expect(bound[0]).toMatchObject({ sourceId: "whatsapp", kind: "jid", value: SELF_JID });

    const me = meEntityId();
    expect(me).not.toBeNull();
    expect(bound[0].entityId).toBe(me);
    // The jid AND its derived phone, so a later Contacts import joins for free.
    const kinds = identitiesOf(me!).map((i) => i.kind);
    expect(kinds).toContain("jid");
    expect(kinds).toContain("phone");
  });

  it("is idempotent and mints exactly one `me`", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    bindSelfIdentities();
    const me = meEntityId();
    bindSelfIdentities();
    bindSelfIdentities();
    expect(meEntityId()).toBe(me);
    expect(countEntities()).toBe(1);
  });

  it("creates `me` even when no source has published a self identity yet", () => {
    expect(bindSelfIdentities()).toEqual([]);
    expect(meEntityId()).not.toBeNull();
  });
});

describe("pendingEntityWork", () => {
  it("lists events with no actor entity and no settled row", () => {
    const ids = speak("111@s.whatsapp.net", "Rohan", 3);
    expect(pendingEntityWork().sort()).toEqual([...ids].sort());
  });

  it("drops an event once its stage row is done", () => {
    const ids = speak("111@s.whatsapp.net", "Rohan", 2);
    setSelfIdentity("whatsapp", SELF_JID);
    rescanEnqueue(ids);
    drainEntityQueue({ now: NOW });
    expect(pendingEntityWork()).toEqual([]);
  });
});

describe("enqueueEntityWork", () => {
  it("refuses to double-file an event rescan already queued under its own id", () => {
    const ids = speak("111@s.whatsapp.net", "Rohan", 2);
    rescanEnqueue(ids);
    expect(enqueueEntityWork(ids, { now: NOW })).toEqual([]);
    const n = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM work_queue WHERE stage = 'entity'`).get() as { n: number }
    ).n;
    expect(n).toBe(2);
  });

  it("files an event nothing has queued yet", () => {
    const ids = speak("111@s.whatsapp.net", "Rohan", 1);
    expect(enqueueEntityWork(ids, { now: NOW })).toHaveLength(1);
  });
});

describe("drainEntityQueue", () => {
  it("reduces many events over few actors to one bind per actor, every event bound", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    const mine = speak(SELF_JID, "Aditya Katare", 40);
    const hers = speak("917742251103@s.whatsapp.net", "Pranjali", 25);
    const mum = speak("918103387076@s.whatsapp.net", "Mummy", 12);
    const all = [...mine, ...hers, ...mum];
    rescanEnqueue(all);

    const report = drainEntityQueue({ now: NOW, limit: all.length });

    expect(report.claimed).toBe(all.length);
    expect(report.bound).toBe(all.length);
    // 3 actors, 3 ladder walks — not 77.
    expect(report.actorsResolved).toBe(3);
    expect(report.unbound).toBe(0);
    expect(report.errors).toEqual([]);
    // Not one event left unattributed.
    expect(actorEntityIds().every((e) => e !== null)).toBe(true);

    // `me` is bound and `is_self` is DERIVED from it, not taken from a source.
    const me = meEntityId();
    expect(report.selfBound).toBe(mine.length);
    const selfRows = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE is_self = 1 AND actor_entity_id = ?`)
      .get(me) as { n: number };
    expect(selfRows.n).toBe(mine.length);
    // The counterparty is emphatically NOT self — this is the mis-attribution.
    const others = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE is_self = 1 AND actor_entity_id <> ?`)
      .get(me) as { n: number };
    expect(others.n).toBe(0);

    // me + the two counterparties, and nobody else.
    expect(countEntities()).toBe(3);
  });

  it("spends zero LLM calls — the `runs` ledger, not the report's word for it", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    const all = [...speak(SELF_JID, "Aditya Katare", 20), ...speak("222@s.whatsapp.net", "Rohan", 20)];
    rescanEnqueue(all);
    const report = drainEntityQueue({ now: NOW, limit: all.length });
    expect(report.llmCalls).toBe(0);
    expect(runsCount()).toBe(0);
  });

  it("is idempotent — a re-run redoes no settled work and mints no second anybody", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    const all = [...speak(SELF_JID, "Aditya Katare", 5), ...speak("222@s.whatsapp.net", "Rohan", 5)];
    rescanEnqueue(all);
    const first = drainEntityQueue({ now: NOW, limit: 100 });
    const entitiesAfter = listEntities().map((e) => e.id).sort();

    const second = drainEntityQueue({ now: NOW, limit: 100 });
    expect(second.claimed).toBe(0);
    expect(second.bound).toBe(0);
    expect(listEntities().map((e) => e.id).sort()).toEqual(entitiesAfter);

    // Even re-queued from scratch, rung ① answers and nothing is minted twice.
    getDb().prepare(`UPDATE work_queue SET state = 'ready' WHERE stage = 'entity'`).run();
    const third = drainEntityQueue({ now: NOW, limit: 100 });
    expect(third.bound).toBe(first.bound);
    expect(third.minted).toBe(0);
    expect(listEntities().map((e) => e.id).sort()).toEqual(entitiesAfter);
  });

  it("leaves a crash mid-drain resumable — done stays done, in-flight comes back", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    const all = speak("222@s.whatsapp.net", "Rohan", 10);
    rescanEnqueue(all);

    drainEntityQueue({ now: NOW, limit: 4 });
    expect(stateOfQueue().done).toBe(4);

    // The crash: four more claimed, the process dies before they settle.
    getDb()
      .prepare(
        `UPDATE work_queue SET state = 'running'
          WHERE stage = 'entity' AND state = 'ready' AND unit_id IN (?, ?, ?)`,
      )
      .run(all[4], all[5], all[6]);

    const resumed = resumeQueue();
    expect(resumed.requeued).toBe(3);
    expect(resumed.rejudged).toEqual([]);
    expect(stateOfQueue().done).toBe(4);

    const after = drainEntityQueue({ now: NOW, limit: 100 });
    expect(after.claimed).toBe(6);
    expect(actorEntityIds().every((e) => e !== null)).toBe(true);
  });

  it("settles an event with no structural actor instead of retrying it forever", () => {
    const id = insertEvent({
      externalId: "orphan-1",
      sourceId: "whatsapp",
      sourceType: "whatsapp",
      streamId: C1,
      actorId: null,
      ts: new Date(NOW).toISOString(),
      kind: "message",
      text: "the broker said friday",
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    }).id;
    rescanEnqueue([id]);
    const report = drainEntityQueue({ now: NOW });
    expect(report.unbound).toBe(1);
    expect(report.bound).toBe(0);
    expect(stateOfQueue().done).toBe(1);
  });

  it("settles a queue row whose event has gone", () => {
    rescanEnqueue(["whatsapp:ghost"]);
    const report = drainEntityQueue({ now: NOW });
    expect(report.orphaned).toBe(1);
    expect(stateOfQueue().done).toBe(1);
  });

  it("quarantines a row that is not an event rather than stalling the lane", () => {
    getDb()
      .prepare(
        `INSERT INTO work_queue (id, unit_kind, unit_id, cohort_id, stage, priority, state)
         VALUES ('wq:entity:session:s1', 'session', 's1', NULL, 'entity', 10, 'ready')`,
      )
      .run();
    const report = drainEntityQueue({ now: NOW });
    expect(report.errors).toHaveLength(1);
    expect(stateOfQueue().quarantined).toBe(1);
  });
});

describe("the agent rung", () => {
  it("PARKS an in-band pair on the batch — P-AG1 is never called inline", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    // Somebody called Rohan already exists; a second jid arrives under the
    // same name. That is a question, not a decision.
    createEntity({ type: "person", canonical: "Rohan", provisional: true });
    const ids = speak("222@s.whatsapp.net", "Rohan", 3);
    rescanEnqueue(ids);

    const batch = new AgentBatch();
    const report = drainEntityQueue({ now: NOW, batch, horizon: "d30", limit: 100 });

    // Bound anyway: the pair being open does not hold the event hostage.
    expect(report.bound).toBe(3);
    expect(report.pairsDeferred).toBe(1);
    expect(batch.size("d30")).toBe(1);
    // Nothing was adjudicated, nothing was merged, nothing was billed.
    expect(runsCount()).toBe(0);
    expect(report.llmCalls).toBe(0);
    expect(listEntities().filter((e) => e.canonical === "Rohan")).toHaveLength(2);
  });

  it("sends the pair to the human queue instead when the path is first-paint", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    createEntity({ type: "person", canonical: "Rohan", provisional: true });
    rescanEnqueue(speak("222@s.whatsapp.net", "Rohan", 1));

    const batch = new AgentBatch();
    const report = drainEntityQueue({ now: NOW, batch, firstPaint: true });
    expect(report.pairsDeferred).toBe(0);
    expect(report.pairsQueued).toBe(1);
    expect(batch.size()).toBe(0);
    const open = (
      getDb().prepare(`SELECT COUNT(*) AS n FROM questions WHERE kind = 'identity'`).get() as { n: number }
    ).n;
    expect(open).toBe(1);
  });

  it("asks nothing at all when the mint has no same-name candidate", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    rescanEnqueue(speak("222@s.whatsapp.net", "Rohan", 2));
    const report = drainEntityQueue({ now: NOW });
    expect(report.pairsDeferred).toBe(0);
    expect(report.pairsQueued).toBe(0);
    expect(report.minted).toBe(1);
  });
});

describe("resolveActorEntity", () => {
  it("returns null for an actor with no external identity — a name is never an id", () => {
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "  ", displayName: "Nobody" });
    expect(resolveActorEntity(actor)).toBeNull();
    expect(resolveActorEntity("whatsapp:ac:missing")).toBeNull();
  });

  it("takes rung ① on the second call and mints nothing", () => {
    const actor = upsertActor({ sourceId: "whatsapp", sourceExtId: "333@s.whatsapp.net", displayName: "Amit" });
    const first = resolveActorEntity(actor);
    const second = resolveActorEntity(actor);
    expect(first!.rung).toBe("mint");
    expect(second!.rung).toBe("exact");
    expect(second!.entityId).toBe(first!.entityId);
    expect(second!.minted).toBe(false);
  });
});

describe("entityPass", () => {
  it("sweeps the backlog onto the queue and works it in one call", () => {
    setSelfIdentity("whatsapp", SELF_JID);
    const all = [...speak(SELF_JID, "Aditya Katare", 6), ...speak("222@s.whatsapp.net", "Rohan", 4)];
    const report = entityPass({ now: NOW, limit: 100 });
    expect(report.bound).toBe(all.length);
    expect(pendingEntityWork()).toEqual([]);
    expect(runsCount()).toBe(0);
  });
});

describe("emptyEntityReport", () => {
  it("starts at zero with an empty error list", () => {
    const report = emptyEntityReport();
    expect(report.claimed + report.bound + report.llmCalls).toBe(0);
    expect(report.errors).toEqual([]);
  });
});
