// ===========================================================================
// [CODE] The re-derivation-after-user-correction scenario behind
// `all_corrections_survive` (build item 4.1; arch §14.2 "user corrections
// surviving re-derivation < 100% fails the build").
//
// Arch §13: "as older cohorts land and arcs grow, re-derivation rebinds to the
// same ids, so labels, pins, spaces and user corrections survive the entire
// import." This corpus makes that a measured number instead of a sentence:
//
//   1. Real temp DB, real migrations. Episodes land, a provisional arc is
//      proposed, and the REAL `reconcile` mints the arc.
//   2. The user corrects it, through the REAL correction paths:
//        · `setUserLabel`  — the user's own words for the space
//        · `pinArc`        — the user pins the thread
//        · a user SPLIT    — one episode walled out, `actor = 'user'`
//   3. FULL RE-DERIVATION: the same evidence (plus a new episode, as a later
//      cohort would add) is proposed again and `reconcile` runs again.
//   4. Each correction is read back off the rows: the arc id rebound (not
//      re-minted), `user_label` intact and winning the surface, `user_pinned`
//      intact, and the split episode still OUT — the wall held.
//
// One observation per correction, so the gate's pass_rate is the fraction of
// corrections that survived. Nothing here writes the corrections back after
// re-deriving — surviving means the PRODUCT preserved them.
//
// A claim-side correction rides along too: a user-edited claim text (recorded
// as an `actor = 'user'` mutation, §11.6 rule 9) must survive both a re-derived
// `writeClaim` of the same statement (the exact-hit path reinforces, never
// rewrites) and an `undoRun` of that re-derivation (a human's edit is never
// reversed — evals R-039), measured through the real write and undo paths.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { arcEpisodeIds, readArc, writeProvisionalArc } from "../../arcs/provisional.js";
import { pinArc, setUserLabel } from "../../arcs/promote-store.js";
import { reconcile } from "../../arcs/reconcile.js";
import { activeClaims, undoRun, writeClaim } from "../../claims/write.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { ensureMeEntity } from "../../entities/binding.js";
import { logMutation } from "../../entities/merge.js";
import type { GateObservation } from "../runner.js";

/** The frozen instant of the run — offline and replayable. */
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

/** Runs `body` against a private, empty database and tears it down after. */
function inFreshDb<T>(body: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "st-eval-corrections-"));
  const previous = process.env.SUPERTWIN_DB_PATH;
  process.env.SUPERTWIN_DB_PATH = join(dir, "eval.db");
  closeDb();
  try {
    return body();
  } finally {
    closeDb();
    if (previous === undefined) delete process.env.SUPERTWIN_DB_PATH;
    else process.env.SUPERTWIN_DB_PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedEpisode(id: string, entityIds: readonly string[], label: string, dayOffset: number): void {
  const started = new Date(NOW - (10 - dayOffset) * 86_400_000).toISOString();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO episodes (id, stream_id, source_id, topic_label, entity_ids, started_at, ended_at)
       VALUES (?, NULL, 'whatsapp', ?, ?, ?, ?)`,
    )
    .run(id, label, JSON.stringify(entityIds), started, started);
}

// ---------------------------------------------------------------------------
// Scenario A — arc corrections across a full re-derivation
// ---------------------------------------------------------------------------

function arcScenario(out: GateObservation[]): void {
  inFreshDb(() => {
    runMigrations();
    const db = getDb();
    for (const [id, name] of [
      ["ent_pranjali", "Pranjali Sachdeva"],
      ["ent_rohan", "Rohan Mehta"],
    ] as const) {
      db.prepare(`INSERT OR REPLACE INTO entities (id, type, canonical, provisional) VALUES (?, 'person', ?, 0)`).run(
        id,
        name,
      );
    }
    const anchors = ["ent_pranjali", "ent_rohan"];
    seedEpisode("cor_ep1", anchors, "goa villa hunt", 0);
    seedEpisode("cor_ep2", anchors, "goa villa hunt", 1);
    seedEpisode("cor_ep3", anchors, "goa villa hunt", 2);

    // First derivation.
    writeProvisionalArc({ batchId: "cor_b1", arcKeyCandidate: "pending", episodeIds: ["cor_ep1", "cor_ep2", "cor_ep3"], now: NOW });
    const first = reconcile({ now: NOW, batchId: "cor_b1", runId: "cor_run1" });
    const arcId = first.groups[0]?.arcId;
    if (!arcId) throw new Error("corrections corpus: first reconcile minted no arc");

    // The user's corrections, through the real paths.
    setUserLabel(arcId, "Goa trip with Pranjali", { actor: "user" });
    pinArc(arcId, { actor: "user" });
    // A user split: cor_ep3 walled out of this arc, exactly as the UI's move
    // writes it — the mutation IS the wall `reconcile` reads.
    logMutation({
      actor: "user",
      targetKind: "arc",
      targetId: arcId,
      field: "split",
      newValue: { episodeIds: ["cor_ep3"] },
      reason: "user split this episode out",
    });
    db.prepare(`DELETE FROM arc_episodes WHERE arc_id = ? AND episode_id = ?`).run(arcId, "cor_ep3");

    // FULL RE-DERIVATION: the same evidence proposed again, plus a new
    // episode, as the next cohort of the import would propose it.
    seedEpisode("cor_ep4", anchors, "goa villa hunt", 3);
    writeProvisionalArc({
      batchId: "cor_b2",
      arcKeyCandidate: "pending",
      episodeIds: ["cor_ep1", "cor_ep2", "cor_ep3", "cor_ep4"],
      now: NOW + 1,
    });
    const second = reconcile({ now: NOW + 1, batchId: "cor_b2", runId: "cor_run2" });
    const reboundId = second.groups[0]?.arcId ?? null;

    const row = readArc(arcId);
    const arcRow = db
      .prepare(`SELECT user_label AS ul, user_pinned AS up, label FROM arcs WHERE id = ?`)
      .get(arcId) as { ul: string | null; up: number | null; label: string | null } | undefined;
    const members = arcEpisodeIds(arcId);

    out.push({
      gate: "all_corrections_survive",
      passed: row !== null && reboundId === arcId,
      note: `re-derivation rebinds to the corrected arc: first=${arcId} second=${String(reboundId)}`,
    });
    out.push({
      gate: "all_corrections_survive",
      passed: arcRow?.ul === "Goa trip with Pranjali",
      note: `user_label after re-derivation: ${JSON.stringify(arcRow?.ul ?? null)}`,
    });
    out.push({
      gate: "all_corrections_survive",
      passed: (arcRow?.up ?? 0) === 1,
      note: `user_pinned after re-derivation: ${String(arcRow?.up ?? 0)}`,
    });
    out.push({
      gate: "all_corrections_survive",
      passed: !members.includes("cor_ep3") && members.includes("cor_ep1") && members.includes("cor_ep4"),
      note: `user split held across re-derivation: members=${JSON.stringify(members.sort())}`,
    });
    // The surface shows the user's words, never the model's, once corrected.
    out.push({
      gate: "all_corrections_survive",
      passed: second.groups[0]?.label === "Goa trip with Pranjali",
      note: `re-derived group label: ${JSON.stringify(second.groups[0]?.label ?? null)}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Scenario B — a claim correction across a re-derived write
// ---------------------------------------------------------------------------

function claimScenario(out: GateObservation[]): void {
  inFreshDb(() => {
    runMigrations();
    const me = ensureMeEntity();
    const model = {
      kind: "fact",
      tag: "F",
      subjectId: me,
      predicate: "flat address",
      text: "Lives at 12 Marine Drive",
      speakerId: me,
      attribution: "first_person",
      statedAt: "2026-08-01T10:00:00.000Z",
    };
    // The model's derivation, then the user's correction: the text edited in
    // place, recorded as an `actor = 'user'` mutation — the record §11.6 rule
    // 9 protects ("a human's edit is never reversed", evals R-039).
    const first = writeClaim(model, { now: "2026-08-01T10:00:01.000Z" });
    getDb()
      .prepare(`UPDATE claim_versions SET text = ? WHERE id = ?`)
      .run("Lives at 14 Marine Drive", first.claimId);
    logMutation({
      actor: "user",
      targetKind: "claim_version",
      targetId: first.claimId,
      field: "text",
      oldValue: "Lives at 12 Marine Drive",
      newValue: "Lives at 14 Marine Drive",
      reason: "user corrected the address",
    });

    // FULL RE-DERIVATION: the same model statement written again under a run,
    // as a re-import would write it. The exact-hit path reinforces — it never
    // rewrites a stored version's text — so the correction must hold.
    writeClaim(model, { now: "2026-08-15T10:00:00.000Z", runId: "cor_rederive" });
    const afterRederive = activeClaims().filter((c) => c.predicate === "flat address");
    out.push({
      gate: "all_corrections_survive",
      passed: afterRederive.length === 1 && afterRederive[0]!.text === "Lives at 14 Marine Drive",
      note: `user-corrected claim after re-derived write: ${JSON.stringify(afterRederive.map((c) => c.text))}`,
    });

    // …and undoing the re-derivation run must not undo the person (R-039).
    const undone = undoRun("cor_rederive");
    const afterUndo = activeClaims().filter((c) => c.predicate === "flat address");
    out.push({
      gate: "all_corrections_survive",
      passed: afterUndo.length === 1 && afterUndo[0]!.text === "Lives at 14 Marine Drive",
      note: `user-corrected claim after undoing the re-derive run (reversed=${undone.reversed.length}, skipped user rows=${undone.skippedUserMutations.length}): ${JSON.stringify(afterUndo.map((c) => c.text))}`,
    });
  });
}

/**
 * Run both scenarios and return the observations. Builds throwaway DBs per
 * call; callers that must emit at most once use {@link correctionsObservations}.
 */
export function buildCorrectionsObservations(): GateObservation[] {
  const out: GateObservation[] = [];
  arcScenario(out);
  claimScenario(out);
  return out;
}

let emitted = false;

/**
 * The scenario's observations, AT MOST ONCE per process — `runSuite` folds
 * every case's observations into one denominator, and a scenario that rode
 * along on every L case would count each correction dozens of times.
 */
export function correctionsObservations(): GateObservation[] {
  if (emitted) return [];
  const out = buildCorrectionsObservations();
  emitted = true;
  return out;
}

/** Test seam: let the next {@link correctionsObservations} emit again. */
export function resetCorrectionsObservationsForTests(): void {
  emitted = false;
}
