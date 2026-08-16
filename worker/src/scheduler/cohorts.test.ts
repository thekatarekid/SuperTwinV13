// ===========================================================================
// Cohort planning, sealing, the state machine and restart (arch §9.1, §9.2,
// §9.3), over a real SQLite DB with real migrations.
//
// The two claims that matter most here are §9.2's ordering — newest first,
// ACROSS ALL STREAMS, with tier primary — and §9.1 rule 3's "coverage on every
// transition, not only on done".
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import type { Tier } from "../tiers/priority.js";
import {
  advanceCohort,
  candidateSessions,
  enrichLookahead,
  orderInversions,
  pendingCohorts,
  readCohort,
  resumeCohorts,
  sealCohort,
} from "./cohorts.js";
import { cohortBudget } from "./horizons.js";
import { readCoverage } from "./queue.js";

const SOURCE = "whatsapp";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const HOUR = 3_600_000;

let tmpDir: string;
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-sched-c-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  seq = 0;
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stream(ext: string, tier: Tier, kind = "dm"): string {
  const id = upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind });
  getDb().prepare(`UPDATE streams SET tier = ?, tier_source = 'code' WHERE id = ?`).run(tier, id);
  return id;
}

/** A sealed session of `events` messages, `chars` characters each, ending `agoMs` ago. */
function session(streamId: string, agoMs: number, events = 8, chars = 55): string {
  seq += 1;
  const id = `s${seq}`;
  const endedAt = new Date(NOW - agoMs).toISOString();
  const startedAt = new Date(NOW - agoMs - 600_000).toISOString();
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: `a${seq}`, displayName: `a${seq}` });
  const eventIds: string[] = [];
  for (let i = 0; i < events; i += 1) {
    const external = `${id}/${i}`;
    const res = insertEvent({
      externalId: external,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId,
      actorId,
      ts: endedAt,
      kind: "message",
      text: "x".repeat(chars),
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
    eventIds.push(res.id);
  }
  getDb()
    .prepare(
      `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, seal_mode)
       VALUES (?, ?, ?, ?, ?, ?, 'sealed', 'immediate')`,
    )
    .run(id, streamId, SOURCE, startedAt, endedAt, JSON.stringify(eventIds));
  return id;
}

// ---------------------------------------------------------------------------

describe("candidates are drawn TIME-FIRST across all streams (§9.2 rule 1)", () => {
  it("interleaves streams, newest first inside a tier", () => {
    const a = stream("alice", "T1");
    const b = stream("bob", "T1");
    const sa1 = session(a, 2 * HOUR);
    const sb1 = session(b, 1 * HOUR);
    const sa2 = session(a, 5 * HOUR);

    const order = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    expect(order.map((c) => c.id)).toEqual([sb1, sa1, sa2]);
    expect(orderInversions(order)).toEqual([]);
  });

  it("puts every T1 session ahead of a newer T4 one — tier is primary (§9.3)", () => {
    const person = stream("alice", "T1");
    const promo = stream("shopmart", "T4");
    const older = session(person, 20 * HOUR);
    const newer = session(promo, 1 * HOUR);

    const order = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    expect(order.map((c) => c.id)).toEqual([older, newer]);
    // Across tiers an older session legitimately precedes a newer one.
    expect(orderInversions(order)).toEqual([]);
  });

  it("catches a recency inversion inside one tier", () => {
    const inverted = [
      { id: "old", tier: "T1" as Tier, tsHi: "2026-08-01T00:00:00.000Z" },
      { id: "new", tier: "T1" as Tier, tsHi: "2026-08-14T00:00:00.000Z" },
    ];
    expect(orderInversions(inverted)).toEqual([{ before: "old", after: "new" }]);
  });

  it("draws only from the asked-for horizon", () => {
    const s = stream("alice", "T1");
    session(s, 2 * HOUR);
    const old = session(s, 40 * 24 * HOUR);
    expect(candidateSessions({ mode: "bootstrap", horizon: "d90", now: NOW }).map((c) => c.id)).toEqual([old]);
  });

  it("leaves an OPEN session alone — §8.2's one exception", () => {
    const s = stream("alice", "T1");
    const open = session(s, 1 * HOUR);
    getDb().prepare(`UPDATE sessions SET status = 'open' WHERE id = ?`).run(open);
    expect(candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW })).toEqual([]);
  });

  it("does not re-offer a session an existing cohort already claimed", () => {
    const s = stream("alice", "T1");
    session(s, 1 * HOUR);
    const candidates = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    sealCohort({ mode: "bootstrap", horizon: "h24", seq: 0, now: NOW, candidates, sourceId: SOURCE });
    expect(candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW })).toEqual([]);
  });
});

describe("sealing a cohort (§9.1)", () => {
  it("takes four quiet sessions at seq 0 and persists them", () => {
    const s = stream("alice", "T1");
    for (let i = 0; i < 6; i += 1) session(s, (i + 1) * HOUR);
    const candidates = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    const cohort = sealCohort({ mode: "bootstrap", horizon: "h24", seq: 0, now: NOW, candidates, sourceId: SOURCE });

    expect(cohort.sessionIds).toHaveLength(cohortBudget(0).sessions);
    expect(cohort.state).toBe("planned");
    expect(cohort.tier).toBe("T1");
    expect(readCohort(cohort.id)?.sessionIds).toEqual(cohort.sessionIds);
  });

  it("records the output estimate and which bound closed the cohort", () => {
    const s = stream("noisy", "T1", "group");
    for (let i = 0; i < 4; i += 1) session(s, (i + 1) * HOUR, 40, 90);
    const candidates = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    const cohort = sealCohort({ mode: "bootstrap", horizon: "h24", seq: 0, now: NOW, candidates, sourceId: SOURCE });

    expect(cohort.closedBy).toBe("output_tokens");
    expect(cohort.sessionIds.length).toBeLessThan(4);
    expect(readCohort(cohort.id)?.outputEstimate).toBe(cohort.outputEstimate);
  });

  it("spans ts_hi..ts_lo over everything it took", () => {
    const s = stream("alice", "T1");
    session(s, 1 * HOUR);
    session(s, 3 * HOUR);
    const candidates = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    const cohort = sealCohort({ mode: "bootstrap", horizon: "h24", seq: 0, now: NOW, candidates, sourceId: SOURCE });
    expect(Date.parse(cohort.tsHi!)).toBeGreaterThan(Date.parse(cohort.tsLo!));
  });
});

describe("the cohort state machine writes coverage on EVERY transition (§9.1 rule 3)", () => {
  function seal(): string {
    const s = stream("alice", "T1");
    for (let i = 0; i < 4; i += 1) session(s, (i + 1) * HOUR);
    const candidates = candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW });
    return sealCohort({ mode: "bootstrap", horizon: "h24", seq: 0, now: NOW, candidates, sourceId: SOURCE }).id;
  }

  it("moves the meter at enriching, ready, understanding and done alike", () => {
    const id = seal();
    const seen: number[] = [];
    for (const state of ["enriching", "ready", "understanding", "done"] as const) {
      const result = advanceCohort(id, state);
      expect(result.refused).toBe(false);
      expect(result.coverage.length).toBeGreaterThan(0);
      seen.push(result.coverage[0]!.fraction);
    }
    // Strictly increasing: a meter that only moves at `done` looks hung.
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.at(-1)).toBe(1);
  });

  it("never regresses when a stale transition arrives late", () => {
    const id = seal();
    advanceCohort(id, "enriching");
    advanceCohort(id, "ready");
    advanceCohort(id, "done");
    const back = advanceCohort(id, "enriching");
    expect(back.refused).toBe(true);
    expect(readCoverage("global", "all")[0]!.fraction).toBe(1);
    expect(readCohort(id)?.state).toBe("done");
  });

  it("writes both the global and the source scope", () => {
    const id = seal();
    advanceCohort(id, "enriching");
    expect(readCoverage("global", "all")).toHaveLength(1);
    expect(readCoverage("source", SOURCE)).toHaveLength(1);
  });

  it("stamps enriched_at and understood_at", () => {
    const id = seal();
    advanceCohort(id, "enriching");
    advanceCohort(id, "ready");
    advanceCohort(id, "understanding");
    advanceCohort(id, "done");
    const row = getDb().prepare(`SELECT enriched_at, understood_at FROM cohorts WHERE id = ?`).get(id) as {
      enriched_at: string | null;
      understood_at: string | null;
    };
    expect(row.enriched_at).not.toBeNull();
    expect(row.understood_at).not.toBeNull();
  });
});

describe("restart resumes at the last completed stage (§9.7 rule 5)", () => {
  it("re-enters an in-flight cohort where it stopped, and skips done ones", () => {
    const s = stream("alice", "T1");
    for (let i = 0; i < 8; i += 1) session(s, (i + 1) * HOUR);
    const first = sealCohort({
      mode: "bootstrap",
      horizon: "h24",
      seq: 0,
      now: NOW,
      candidates: candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW }),
      sourceId: SOURCE,
    });
    const second = sealCohort({
      mode: "bootstrap",
      horizon: "h24",
      seq: 1,
      now: NOW,
      candidates: candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW }),
      sourceId: SOURCE,
    });
    advanceCohort(first.id, "enriching");
    advanceCohort(first.id, "ready");
    advanceCohort(first.id, "understanding");
    advanceCohort(first.id, "done");
    advanceCohort(second.id, "enriching");

    // A fresh handle: the same thing a restart sees.
    closeDb();
    const resumed = resumeCohorts();
    expect(resumed).toEqual([{ id: second.id, resumeFrom: "planned", resumeAt: "enriching" }]);
    expect(pendingCohorts().map((c) => c.id)).toEqual([second.id]);
  });

  it("keeps the pending queue in priority order, never rowid order", () => {
    const person = stream("alice", "T1");
    const promo = stream("shopmart", "T4");
    session(promo, 1 * HOUR);
    const promoCohort = sealCohort({
      mode: "bootstrap",
      horizon: "h24",
      seq: 0,
      now: NOW,
      candidates: candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW, tier: "T4" }),
      sourceId: SOURCE,
      idPrefix: "promo",
    });
    session(person, 10 * HOUR);
    const personCohort = sealCohort({
      mode: "bootstrap",
      horizon: "h24",
      seq: 0,
      now: NOW,
      candidates: candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW, tier: "T1" }),
      sourceId: SOURCE,
      idPrefix: "person",
    });
    expect(pendingCohorts().map((c) => c.id)).toEqual([personCohort.id, promoCohort.id]);
  });
});

describe("lane E's lookahead (§9.4 rule 3)", () => {
  it("is 2 cohorts in bootstrap and 1 in steady", () => {
    const s = stream("alice", "T1");
    for (let i = 0; i < 12; i += 1) session(s, (i + 1) * HOUR);
    for (const n of [0, 1, 2]) {
      sealCohort({
        mode: "bootstrap",
        horizon: "h24",
        seq: n,
        now: NOW,
        candidates: candidateSessions({ mode: "bootstrap", horizon: "h24", now: NOW }),
        sourceId: SOURCE,
      });
    }
    const queue = pendingCohorts();
    expect(enrichLookahead("bootstrap", queue)).toHaveLength(2);
    expect(enrichLookahead("steady", queue)).toHaveLength(1);
  });
});
