// ===========================================================================
// [CODE] The full-import + restart corpus behind the four scheduler gates that
// only an INTEGRATION run can measure (build item 4.1):
//
//   sched_recency_order          processing order recency-descending, measured
//                                over the order the REAL CohortQueue drained
//   sched_bootstrap_seal_immediate  every bootstrap session sealed by the REAL
//                                `sealDue` decision, mode read back off the row
//   sched_live_preempts_backfill the live cohort's measured `delay` — §9.3's
//                                "at the next cohort boundary", so ≤ 1
//   sched_restart_no_rejudge     a mid-import kill + reopen of the SAME
//                                database file; a unit whose verdict already
//                                landed is never re-run
//
// Nothing below stubs a decision: sessions are sealed by `sealDue` (bootstrap
// branch), cohorts are drawn by `candidateSessions` and closed by `sealCohort`,
// the drain order comes out of `CohortQueue` (the §9.3 rules, live exception
// included), inversions are counted by `orderInversions`, and the restart is a
// literal `closeDb()` with the DB path held — the next `getDb()` reopens the
// file exactly as a process restart would, and `resumeQueue` / `resumeCohorts`
// do the resuming. The clock is one frozen instant (`NOW`), so the whole run
// is deterministic and offline.
//
// The corpus emits observations for these four gates ONLY, at most once per
// process (the `episodes-traffic.ts` pattern) so `runSuite`'s fold counts each
// measured fact exactly once.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { insertEvent, upsertActor, upsertSource, upsertStream } from "../../db/ingest.js";
import { persistVerdict } from "../../episodes/store.js";
import {
  advanceCohort,
  candidateSessions,
  orderInversions,
  resumeCohorts,
  sealCohort,
  type Cohort,
} from "../../scheduler/cohorts.js";
import { horizonLadder } from "../../scheduler/horizons.js";
import { claimWork, enqueueWork, resumeQueue, workId } from "../../scheduler/queue.js";
import { resolvePolicy } from "../../sessions/policies.js";
import { sealDue } from "../../sessions/seal.js";
import type { SegSession } from "../../sessions/segment.js";
import { CohortQueue, computePriority, type Tier } from "../../tiers/priority.js";
import type { GateObservation } from "../runner.js";

const SOURCE = "whatsapp";
/** The frozen instant of the run — offline and replayable. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");
const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// The authored import — three streams, sessions across three horizons
// ---------------------------------------------------------------------------

interface SessionSpec {
  stream: string;
  tier: Tier;
  kind: "dm" | "group";
  /** Hours before NOW the session ended. */
  agoHours: number;
  events: number;
}

/**
 * A small but real backfill: two T1 DMs and one T2 group, with sessions spread
 * over h24 / d7 / d30 so the horizon walk actually walks and the recency gate
 * has neighbours to invert.
 */
function importCorpus(): SessionSpec[] {
  return [
    { stream: "alice", tier: "T1", kind: "dm", agoHours: 2, events: 6 },
    { stream: "alice", tier: "T1", kind: "dm", agoHours: 20, events: 8 },
    { stream: "alice", tier: "T1", kind: "dm", agoHours: 3 * 24, events: 5 },
    { stream: "alice", tier: "T1", kind: "dm", agoHours: 10 * 24, events: 7 },
    { stream: "bob", tier: "T1", kind: "dm", agoHours: 5, events: 4 },
    { stream: "bob", tier: "T1", kind: "dm", agoHours: 2 * 24, events: 6 },
    { stream: "bob", tier: "T1", kind: "dm", agoHours: 20 * 24, events: 5 },
    { stream: "team", tier: "T2", kind: "group", agoHours: 8, events: 9 },
    { stream: "team", tier: "T2", kind: "group", agoHours: 4 * 24, events: 6 },
    { stream: "team", tier: "T2", kind: "group", agoHours: 15 * 24, events: 8 },
  ];
}

// ---------------------------------------------------------------------------
// Building the world — events in, sessions sealed by the REAL decision
// ---------------------------------------------------------------------------

interface BuiltSession {
  id: string;
  streamId: string;
  tier: Tier;
  tsHi: string;
  /** The mode `sealDue` decided, and the mode the row carries. */
  decidedMode: string | null;
  storedMode: string | null;
  priority: number;
}

function buildSession(
  spec: SessionSpec,
  index: number,
  streamIds: Map<string, string>,
  out: GateObservation[],
): BuiltSession {
  const db = getDb();
  let streamId = streamIds.get(spec.stream);
  if (!streamId) {
    streamId = upsertStream({ sourceId: SOURCE, sourceExtId: spec.stream, name: spec.stream, kind: spec.kind });
    db.prepare(`UPDATE streams SET tier = ?, tier_source = 'code' WHERE id = ?`).run(spec.tier, streamId);
    streamIds.set(spec.stream, streamId);
  }
  const sessionId = `imp_s${index}`;
  const endedMs = NOW - spec.agoHours * HOUR;
  const startedMs = endedMs - 30 * 60_000;
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: `${spec.stream}-actor`, displayName: spec.stream });

  const eventIds: string[] = [];
  for (let i = 0; i < spec.events; i += 1) {
    const res = insertEvent({
      externalId: `${sessionId}/${i}`,
      sourceId: SOURCE,
      sourceType: SOURCE,
      streamId,
      actorId,
      ts: new Date(startedMs + i * 60_000).toISOString(),
      kind: "message",
      text: `imported message ${i} of ${sessionId}`,
      mediaPath: null,
      rawJson: null,
      isHistorical: true,
    });
    eventIds.push(res.id);
  }

  // The REAL seal decision, in bootstrap: the next row is already known, so
  // §10.4 says immediate. Nothing here hardcodes the mode — a regression in
  // `sealDue`'s bootstrap branch fails the gate.
  const open: SegSession = {
    id: sessionId,
    stream_key: streamId,
    source_id: SOURCE,
    tz: "Asia/Kolkata",
    kind: spec.kind,
    started_at: new Date(startedMs).toISOString(),
    ended_at: new Date(endedMs).toISOString(),
    event_ids: eventIds,
    actors: [actorId],
    boundary_reason_start: "gap",
    boundary_reason_end: "gap",
    boundary_params: { start: {}, end: { rule: "gap" } },
    status: "open",
    seal_mode: null,
    sealed_at: null,
    content_hash: null,
    superseded_hash: null,
    hash_version: "v1",
    late_arrival: false,
    overlap_of: null,
    attachments: [],
    event_count: eventIds.length,
    chars: eventIds.length * 30,
    tokens: eventIds.length * 8,
    collapsed_count: 0,
    active_ms: 0,
    coarse: false,
  };
  const decision = sealDue(open, {
    policy: resolvePolicy({ kind: "conversation" }),
    run_mode: "bootstrap",
    now: NOW,
  });

  db.prepare(
    `INSERT INTO sessions (id, stream_id, source_id, started_at, ended_at, event_ids, status, seal_mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    streamId,
    SOURCE,
    open.started_at,
    open.ended_at,
    JSON.stringify(eventIds),
    decision.seal ? "sealed" : "open",
    decision.mode,
  );
  const stored = getDb().prepare(`SELECT seal_mode AS m FROM sessions WHERE id = ?`).get(sessionId) as {
    m: string | null;
  };

  out.push({
    gate: "sched_bootstrap_seal_immediate",
    passed: decision.mode === "immediate" && stored.m === "immediate",
    note: `bootstrap session ${sessionId} (${spec.stream}, ${spec.agoHours}h ago): sealDue → ${String(decision.mode)}, row carries ${String(stored.m)}`,
  });

  return {
    id: sessionId,
    streamId,
    tier: spec.tier,
    tsHi: open.ended_at,
    decidedMode: decision.mode,
    storedMode: stored.m,
    priority: computePriority({ tier: spec.tier, horizon: "h24", ts: open.ended_at, now: NOW }),
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run the full import + restart scenario and return the observations. Builds
 * its own throwaway DB per call; callers that must emit at most once use
 * {@link schedImportObservations}.
 */
export function buildSchedImportObservations(): GateObservation[] {
  const dir = mkdtempSync(join(tmpdir(), "supertwin-eval-schedimp-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "import.db");
  closeDb();
  const out: GateObservation[] = [];
  try {
    runMigrations();
    upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });

    // ---- ingest + seal (gate: bootstrap seal mode) ------------------------
    const streamIds = new Map<string, string>();
    const built = importCorpus().map((spec, i) => buildSession(spec, i, streamIds, out));
    const byId = new Map(built.map((b) => [b.id, b]));

    // ---- the horizon walk — REAL candidates, REAL cohorts -----------------
    const cohorts: Cohort[] = [];
    let seq = 0;
    for (const horizon of horizonLadder()) {
      // Draw until this horizon is exhausted, exactly as bootstrap does.
      for (;;) {
        const candidates = candidateSessions({ mode: "bootstrap", horizon, now: NOW, sourceId: SOURCE });
        if (candidates.length === 0) break;
        const cohort = sealCohort({ mode: "bootstrap", horizon, seq, now: NOW, sourceId: SOURCE, candidates });
        seq += 1;
        if (cohort.sessionIds.length === 0) break;
        cohorts.push(cohort);
      }
    }

    // ---- the drain — REAL CohortQueue, live arrival mid-cohort-0 ----------
    const queue = new CohortQueue(NOW);
    for (const cohort of cohorts) {
      queue.push({ id: cohort.id, tier: cohort.tier, horizon: cohort.horizon, ts: cohort.tsHi ?? undefined });
    }
    queue.next(); // cohort 0 is in flight when the live event lands.
    const liveId = "coh:live:arrival";
    queue.arrive({ id: liveId, tier: "T1", horizon: "live", ts: NOW });
    const ran = queue.drain();

    const liveRecord = ran.find((r) => r.id === liveId);
    out.push({
      gate: "sched_live_preempts_backfill",
      passed: liveRecord !== undefined && liveRecord.delay <= 1,
      value: liveRecord?.delay ?? Number.POSITIVE_INFINITY,
      note: liveRecord
        ? `live T1 cohort arrived mid-cohort-0 and ran with delay ${liveRecord.delay} (preempted=${liveRecord.preempted})`
        : "live cohort never ran",
    });

    // ---- recency order over the drained order (gate: recency) -------------
    const cohortById = new Map(cohorts.map((c) => [c.id, c]));
    const processedOrder = ran
      .filter((r) => r.id !== liveId)
      .flatMap((r) => cohortById.get(r.id)?.sessionIds ?? [])
      .map((id) => {
        const b = byId.get(id)!;
        return { id, tier: b.tier, tsHi: b.tsHi };
      });
    const inversions = orderInversions(processedOrder);
    for (const inv of inversions) {
      out.push({
        gate: "sched_recency_order",
        passed: false,
        note: `recency inversion in the drained import order: ${inv.before} processed before newer ${inv.after}`,
      });
    }
    if (inversions.length === 0) {
      out.push({
        gate: "sched_recency_order",
        passed: true,
        note: `full-import drain of ${processedOrder.length} sessions across ${cohorts.length} cohort(s) is recency-descending within every tier`,
      });
    }

    // ---- mid-import restart (gate: no re-judge) ---------------------------
    const [cohortA, cohortB] = cohorts;
    if (!cohortA || !cohortB) throw new Error("sched-import corpus: expected at least two cohorts");

    const enqueueAll = (cohort: Cohort): void => {
      for (const sessionId of cohort.sessionIds) {
        enqueueWork({
          unitKind: "session",
          unitId: sessionId,
          stage: "episode",
          // The cohort's own §9.3 priority — so cohort A's items outrank
          // cohort B's in the queue exactly as their cohorts did in the drain.
          priority: cohort.priority,
          cohortId: cohort.id,
        });
      }
    };
    enqueueAll(cohortA);
    enqueueAll(cohortB);

    // Cohort A runs to completion: claimed, judged (verdict persisted), done.
    advanceCohort(cohortA.id, "enriching");
    advanceCohort(cohortA.id, "ready");
    advanceCohort(cohortA.id, "understanding");
    const claimedA = claimWork({ stages: ["episode"], limit: cohortA.sessionIds.length, nowIso: new Date(NOW).toISOString() });
    for (const item of claimedA) {
      persistVerdict({ episodeId: null, sessionId: item.unitId, decision: "one_to_one", candidates: null, output: null });
      getDb().prepare(`UPDATE work_queue SET state = 'done' WHERE id = ?`).run(item.id);
    }
    advanceCohort(cohortA.id, "done");

    // Cohort B is mid-flight: everything claimed, ONE verdict landed, and the
    // process dies before anything is marked done.
    advanceCohort(cohortB.id, "enriching");
    advanceCohort(cohortB.id, "ready");
    advanceCohort(cohortB.id, "understanding");
    const claimedB = claimWork({ stages: ["episode"], limit: cohortB.sessionIds.length, nowIso: new Date(NOW).toISOString() });
    const judgedMidFlight = claimedB[0] ?? null;
    if (judgedMidFlight) {
      persistVerdict({
        episodeId: null,
        sessionId: judgedMidFlight.unitId,
        decision: "one_to_one",
        candidates: null,
        output: null,
      });
    }

    // THE RESTART. The path stays; the handle is dropped, as a kill drops it.
    closeDb();

    const report = resumeQueue();
    const resumed = resumeCohorts();
    const cohortBResume = resumed.find((r) => r.id === cohortB.id);

    out.push({
      gate: "sched_restart_no_rejudge",
      passed: report.rejudged.length === 0,
      note: `restart resume: requeued=${report.requeued} verdictsKept=${report.verdictsKept} rejudged=${JSON.stringify(report.rejudged)}; cohort B resumes at ${String(cohortBResume?.resumeAt)}`,
    });

    // A resumed scheduler re-plans its cohorts. Every unit whose verdict
    // already landed must be refused — and its queue row must not be runnable.
    const judgedSessions = new Set<string>([...cohortA.sessionIds, ...(judgedMidFlight ? [judgedMidFlight.unitId] : [])]);
    for (const sessionId of judgedSessions) {
      const again = enqueueWork({
        unitKind: "session",
        unitId: sessionId,
        stage: "episode",
        priority: byId.get(sessionId)?.priority ?? 0,
      });
      const row = getDb()
        .prepare(`SELECT state AS s FROM work_queue WHERE id = ?`)
        .get(workId("episode", "session", sessionId)) as { s: string } | undefined;
      const refused = again.action === "skipped_done" || again.action === "skipped_verdict";
      const notRunnable = row !== undefined && row.s === "done";
      out.push({
        gate: "sched_restart_no_rejudge",
        passed: refused && notRunnable,
        note: `judged session ${sessionId}: re-enqueue after restart → ${again.action}, queue row ${String(row?.s)}`,
      });
    }

    return out;
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

let emitted = false;

/**
 * The corpus's observations, AT MOST ONCE per process — `runSuite` folds every
 * case's observations into one denominator, and a corpus that rode along on
 * every T case would count each measured fact dozens of times.
 */
export function schedImportObservations(): GateObservation[] {
  if (emitted) return [];
  const out = buildSchedImportObservations();
  emitted = true;
  return out;
}

/** Test seam: let the next {@link schedImportObservations} emit again. */
export function resetSchedImportObservationsForTests(): void {
  emitted = false;
}
