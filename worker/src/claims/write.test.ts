// ===========================================================================
// The claim write path (build item 3.3, arch §11.6; evals R, 40 cases).
//
// Everything here runs against a real temp SQLite database with the real
// migrations, so `claims_active` is the VIEW from 0020 and not a re-implemented
// idea of one. Three things are proved rather than asserted:
//
//   * a repeat is a reinforcement and adds NO row, at any evidence count;
//   * an older claim arriving late lands as a predecessor with a closed
//     window, and the newer claim stays active;
//   * the same corpus written in four different orders produces one graph.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb } from "../db/connection.js";
import { runMigrations } from "../db/index.js";
import { claimKey } from "./keys.js";
import {
  activeClaims,
  CLAIM_NEAR_HIT_MIN,
  evidenceOf,
  nearHitCandidates,
  pickNearHit,
  readClaimVersion,
  undoRun,
  versionsOfKey,
  writeClaim,
  type ClaimAdjudicator,
  type ClaimWriteInput,
} from "./write.js";

const NOW = "2026-08-15T12:00:00.000Z";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "st-claim-write-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  closeDb();
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO entities (id, type, canonical) VALUES ('en_rahul','person','Rahul Arora')`).run();
  for (const [id, ts] of [
    ["ev1", "2026-03-02T10:00:00Z"],
    ["ev2", "2026-05-04T10:00:00Z"],
    ["ev3", "2026-08-11T10:00:00Z"],
    ["ev4", "2026-08-12T10:00:00Z"],
    ["ev5", "2026-08-13T10:00:00Z"],
  ]) {
    db.prepare(`INSERT INTO events (id, ts, kind, text) VALUES (?, ?, 'message', 'x')`).run(id, ts);
  }
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function claim(over: Partial<ClaimWriteInput> = {}): ClaimWriteInput {
  return {
    kind: "fact",
    tag: "F",
    subjectId: "en_rahul",
    predicate: "Lives in Koramangala.",
    text: "Lives in Koramangala.",
    confidence: 0.8,
    statedAt: "2026-03-02T10:00:00Z",
    evidence: [{ eventId: "ev1", quote: "my place in koramangala" }],
    ...over,
  };
}

function claimCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM claim_versions`).get() as { n: number }).n;
}

/** A frozen P-AG3 that answers with one line, whatever it is asked. */
function adjudicator(line: string): ClaimAdjudicator {
  return () => ({ response: line });
}

// ---- R-001..009 — reinforcement ---------------------------------------------

describe("exact claim_key hit → reinforce", () => {
  it("adds no row, unions the evidence and takes the max confidence", () => {
    const first = writeClaim(claim(), { now: NOW });
    expect(first.route).toBe("insert");

    const again = writeClaim(
      claim({ confidence: 0.95, evidence: [{ eventId: "ev2", quote: "still in koramangala" }] }),
      { now: NOW },
    );
    expect(again.route).toBe("reinforce");
    expect(again.created).toBe(false);
    expect(again.claimId).toBe(first.claimId);
    expect(claimCount()).toBe(1);
    expect(evidenceOf(first.claimId)).toEqual(["ev1", "ev2"]);
    expect(readClaimVersion(first.claimId)?.confidence).toBe(0.95);
  });

  it("never lowers the confidence a stronger extraction already gave", () => {
    const first = writeClaim(claim({ confidence: 0.95 }), { now: NOW });
    writeClaim(claim({ confidence: 0.4, evidence: [{ eventId: "ev2", quote: "q" }] }), { now: NOW });
    expect(readClaimVersion(first.claimId)?.confidence).toBe(0.95);
  });

  it("reinforces a habit five times over with no MIN_EVIDENCE constant in sight", () => {
    const events = ["ev1", "ev2", "ev3", "ev4", "ev5"];
    let id = "";
    events.forEach((eventId, i) => {
      const result = writeClaim(
        claim({
          kind: "habit",
          tag: "H",
          predicate: "Runs on Sunday mornings.",
          text: "Runs on Sunday mornings.",
          evidence: [{ eventId, quote: `run ${i}` }],
        }),
        { now: NOW },
      );
      if (i === 0) id = result.claimId;
      else expect(result.route).toBe("reinforce");
    });
    expect(claimCount()).toBe(1);
    // Graduation is the evidence count a reader can SEE, not a threshold.
    expect(evidenceOf(id)).toHaveLength(5);
  });

  it("folds stated_at to the latest — a restatement WAS said later", () => {
    const first = writeClaim(claim(), { now: NOW });
    writeClaim(claim({ statedAt: "2026-08-11T10:00:00Z", evidence: [{ eventId: "ev3", quote: "q" }] }), {
      now: NOW,
    });
    expect(readClaimVersion(first.claimId)?.statedAt).toBe("2026-08-11T10:00:00Z");
    // …and an OLDER restatement cannot pull it back.
    writeClaim(claim({ statedAt: "2026-01-01T10:00:00Z", evidence: [{ eventId: "ev2", quote: "q" }] }), {
      now: NOW,
    });
    expect(readClaimVersion(first.claimId)?.statedAt).toBe("2026-08-11T10:00:00Z");
  });

  it("reports a cited event the database does not have, instead of inventing it", () => {
    const result = writeClaim(claim({ evidence: [{ eventId: "nope", quote: "q" }] }), { now: NOW });
    expect(result.evidenceMissing).toEqual(["nope"]);
    expect(result.evidenceAdded).toEqual([]);
  });
});

// ---- R-010..015 — the near-hit route ----------------------------------------

describe("near hit → P-AG3", () => {
  const near = claim({ predicate: "Lives in Indiranagar.", text: "Lives in Indiranagar." });

  function seed(): string {
    return writeClaim(claim(), { now: NOW }).claimId;
  }

  it("routes a calibrated near hit to the adjudicator", () => {
    const stored = seed();
    let asked = 0;
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: (req) => {
        asked += 1;
        expect(req.storedId).toBe(stored);
        expect(req.prompt.user).toContain("SUBJ");
        return { response: "V|A|B|dst|-|-|0.8|two different flats" };
      },
    });
    expect(asked).toBe(1);
    expect(result.route).toBe("adjudicated");
  });

  it("nominates at every calibrated score the evals pose", () => {
    const stored = seed();
    for (const similarity of [0.88, 0.9, 0.92, 0.94, 0.96, 0.98]) {
      const candidates = nearHitCandidates(near, claimKey(near));
      expect(pickNearHit(candidates, [{ claimId: stored, similarity }])?.row.id).toBe(stored);
    }
  });

  it("does not nominate below the MEASURED band", () => {
    const stored = seed();
    const candidates = nearHitCandidates(near, claimKey(near));
    expect(pickNearHit(candidates, [{ claimId: stored, similarity: CLAIM_NEAR_HIT_MIN - 0.01 }])).toBeNull();
    expect(pickNearHit(candidates, [])).toBeNull();
  });

  it("dup → reinforce, no new row (a duplicate becomes evidence)", () => {
    const stored = seed();
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: adjudicator("V|A|B|dup|-|-|0.9|same flat, two wordings"),
    });
    expect(result.reinforced).toBe(true);
    expect(result.claimId).toBe(stored);
    expect(claimCount()).toBe(1);
  });

  it("rfn → supersede, reason 'refinement'", () => {
    const stored = seed();
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: adjudicator("V|A|B|rfn|b|-|0.9|the incoming one is more precise"),
    });
    expect(claimCount()).toBe(2);
    // Both were said at the same instant; the id tiebreak decides, as the view does.
    expect(result.closedId).not.toBeNull();
    expect(readClaimVersion(result.closedId as string)?.closedReason).toBe("refinement");
  });

  it("ctr → supersede + valid_to on the EARLIER claim", () => {
    const stored = writeClaim(claim({ statedAt: "2026-08-11T10:00:00Z" }), { now: NOW }).claimId;
    const result = writeClaim(
      { ...near, statedAt: "2026-03-02T10:00:00Z", evidence: [{ eventId: "ev1", quote: "q" }] },
      {
        now: NOW,
        candidates: [{ claimId: stored, similarity: 0.9 }],
        adjudicator: adjudicator("V|A|B|ctr|a|2026-09-01|0.9|B was said five months before A"),
      },
    );
    expect(result.closedId).toBe(result.claimId);
    const closed = readClaimVersion(result.claimId);
    expect(closed?.closedBy).toBe(stored);
    expect(closed?.validTo).toBe("2026-09-01");
    expect(activeClaims().map((c) => c.id)).toEqual([stored]);
  });

  it("dst → insert, both live", () => {
    const stored = seed();
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: adjudicator("V|A|B|dst|-|-|0.8|two different flats"),
    });
    expect(result.created).toBe(true);
    expect(result.closedId).toBeNull();
    expect(activeClaims()).toHaveLength(2);
  });

  it("un → insert + a question, never a silent choice", () => {
    const stored = seed();
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: adjudicator("V|A|B|un|-|-|0.4|cannot tell"),
    });
    expect(result.created).toBe(true);
    expect(result.questionId).not.toBeNull();
    const row = getDb()
      .prepare(`SELECT status, target_id FROM questions WHERE id = ?`)
      .get(result.questionId) as { status: string; target_id: string };
    expect(row).toMatchObject({ status: "open", target_id: result.claimId });
  });

  it("defers rather than guessing when no adjudicator is wired (§9.5.1)", () => {
    const stored = seed();
    const result = writeClaim(near, { now: NOW, candidates: [{ claimId: stored, similarity: 0.9 }] });
    expect(result.route).toBe("insert");
    expect(result.adjudicationDeferred).toBe(true);
    expect(activeClaims()).toHaveLength(2);
  });

  it("keeps the whole answer, including lines it could not use (R-040)", () => {
    const stored = seed();
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: adjudicator(["V|A|B|dst|-|-|0.8|one", "Y|e1|a summary nobody asked for"].join("\n")),
    });
    expect(result.adjudication?.otherRecords).toHaveLength(1);
    expect(result.adjudication?.verdict?.raw).toBe("V|A|B|dst|-|-|0.8|one");
  });

  it("inserts, and never throws, when the adjudicator answers with nothing usable", () => {
    const stored = seed();
    const result = writeClaim(near, {
      now: NOW,
      candidates: [{ claimId: stored, similarity: 0.9 }],
      adjudicator: adjudicator("¯\\_(ツ)_/¯"),
    });
    expect(result.created).toBe(true);
    expect(result.closedId).toBeNull();
  });
});

// ---- R-021..027 — precedence by stated_at -----------------------------------

describe("precedence is stated_at, never arrival", () => {
  const later = claim({
    predicate: "Lives in Indiranagar.",
    text: "Lives in Indiranagar.",
    statedAt: "2026-08-11T10:00:00Z",
    evidence: [{ eventId: "ev3", quote: "shifting to Indiranagar" }],
  });
  const earlier = claim({ statedAt: "2026-03-02T10:00:00Z" });

  function contradict(first: ClaimWriteInput, second: ClaimWriteInput): void {
    const a = writeClaim(first, { now: NOW });
    writeClaim(second, {
      now: NOW,
      candidates: [{ claimId: a.claimId, similarity: 0.9 }],
      adjudicator: adjudicator("V|A|B|ctr|-|2026-09-01|0.9|the residence changed"),
    });
  }

  it("the older claim arriving LAST is a predecessor with a closed window", () => {
    contradict(later, earlier);
    const active = activeClaims();
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe("Lives in Indiranagar.");
    const closed = versionsOfKey(claimKey(earlier))[0];
    expect(closed.closedBy).toBe(active[0].id);
    expect(closed.validTo).toBe("2026-09-01");
  });

  it("the same pair the other way round produces the same graph", () => {
    contradict(earlier, later);
    const active = activeClaims();
    expect(active).toHaveLength(1);
    expect(active[0].text).toBe("Lives in Indiranagar.");
    expect(versionsOfKey(claimKey(earlier))[0].closedBy).toBe(active[0].id);
  });

  it("nothing is deleted — both versions survive either way round", () => {
    contradict(later, earlier);
    expect(claimCount()).toBe(2);
  });

  it("ingested_at is never what decides — a row written later, said earlier, loses", () => {
    contradict(later, earlier);
    const rows = getDb()
      .prepare(`SELECT id, stated_at, ingested_at FROM claim_versions ORDER BY ingested_at`)
      .all() as { id: string; stated_at: string; ingested_at: string }[];
    // The LAST row written is the one that lost, which is only possible if
    // precedence read stated_at.
    expect(rows).toHaveLength(2);
    expect(readClaimVersion(rows[1].id)?.closedBy).not.toBeNull();
  });
});

// ---- R-028..031 — confluence ------------------------------------------------

describe("confluence", () => {
  const corpus: ClaimWriteInput[] = [
    claim({ statedAt: "2026-03-02T10:00:00Z", evidence: [{ eventId: "ev1", quote: "koramangala" }] }),
    claim({
      predicate: "Lives in Indiranagar.",
      text: "Lives in Indiranagar.",
      statedAt: "2026-08-11T10:00:00Z",
      evidence: [{ eventId: "ev3", quote: "indiranagar" }],
    }),
    claim({
      kind: "preference",
      tag: "P",
      predicate: "Prefers filter coffee.",
      text: "Prefers filter coffee.",
      statedAt: "2026-05-04T10:00:00Z",
      evidence: [{ eventId: "ev2", quote: "filter kaapi" }],
    }),
  ];

  /** Writes a corpus in one order and returns the graph, normalised. */
  function graphOf(order: readonly number[]): unknown {
    closeDb();
    rmSync(join(tmpDir, "test.db"), { force: true });
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO entities (id, type, canonical) VALUES ('en_rahul','person','Rahul Arora')`).run();
    for (const [id, ts] of [
      ["ev1", "2026-03-02T10:00:00Z"],
      ["ev2", "2026-05-04T10:00:00Z"],
      ["ev3", "2026-08-11T10:00:00Z"],
    ]) {
      db.prepare(`INSERT INTO events (id, ts, kind, text) VALUES (?, ?, 'message', 'x')`).run(id, ts);
    }
    for (const index of order) {
      const item = corpus[index];
      const candidates = versionsOfKey("")
        .concat(activeClaims())
        .filter((row) => row.kind === item.kind && row.claimKey !== claimKey(item))
        .map((row) => ({ claimId: row.id, similarity: 0.9 }));
      writeClaim(item, {
        now: NOW,
        candidates,
        adjudicator: adjudicator("V|A|B|ctr|-|2026-09-01|0.9|the residence changed"),
      });
    }
    return getDb()
      .prepare(
        `SELECT id, claim_key, text, stated_at, valid_to, closed_by, closed_reason, confidence
           FROM claim_versions ORDER BY id`,
      )
      .all();
  }

  it("the same corpus in four ingest orders produces one identical graph", () => {
    const a = graphOf([0, 1, 2]);
    const b = graphOf([1, 0, 2]);
    const c = graphOf([2, 1, 0]);
    const d = graphOf([2, 0, 1]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(d).toEqual(a);
  });
});

// ---- R-036..039 — mutations and undo ----------------------------------------

describe("mutations and undo", () => {
  function mutationCount(runId: string): number {
    return (
      getDb().prepare(`SELECT COUNT(*) AS n FROM mutations WHERE run_id = ?`).get(runId) as { n: number }
    ).n;
  }

  it("every write emits a mutations row", () => {
    const result = writeClaim(claim(), { now: NOW, runId: "run1" });
    expect(result.mutationIds.length).toBeGreaterThan(0);
    expect(mutationCount("run1")).toBe(result.mutationIds.length);
  });

  it("a reinforcement and a close emit their own rows", () => {
    writeClaim(claim(), { now: NOW, runId: "run1" });
    writeClaim(claim({ evidence: [{ eventId: "ev2", quote: "again" }] }), { now: NOW, runId: "run2" });
    const fields = (
      getDb().prepare(`SELECT field FROM mutations WHERE run_id = 'run2'`).all() as { field: string }[]
    ).map((r) => r.field);
    expect(fields).toContain("reinforce");
    expect(fields).toContain("insert");
  });

  it("undo reverse-replays a run: the claim, its evidence and its question go", () => {
    const seeded = writeClaim(claim(), { now: NOW, runId: "run1" });
    const second = writeClaim(
      claim({
        predicate: "Lives in Indiranagar.",
        text: "Lives in Indiranagar.",
        statedAt: "2026-08-11T10:00:00Z",
        evidence: [{ eventId: "ev3", quote: "indiranagar" }],
      }),
      {
        now: NOW,
        runId: "run2",
        candidates: [{ claimId: seeded.claimId, similarity: 0.9 }],
        adjudicator: adjudicator("V|A|B|un|-|-|0.4|cannot tell"),
      },
    );
    expect(claimCount()).toBe(2);

    const undone = undoRun("run2");
    expect(undone.reversed.length).toBeGreaterThan(0);
    expect(claimCount()).toBe(1);
    expect(readClaimVersion(second.claimId)).toBeNull();
    expect(readClaimVersion(seeded.claimId)).not.toBeNull();
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM questions`).get()).toEqual({ n: 0 });
  });

  it("undo restores a closed window rather than deleting the row that closed it", () => {
    const older = writeClaim(claim(), { now: NOW, runId: "run1" });
    writeClaim(
      claim({
        predicate: "Lives in Indiranagar.",
        text: "Lives in Indiranagar.",
        statedAt: "2026-08-11T10:00:00Z",
        evidence: [{ eventId: "ev3", quote: "indiranagar" }],
      }),
      {
        now: NOW,
        runId: "run2",
        candidates: [{ claimId: older.claimId, similarity: 0.9 }],
        adjudicator: adjudicator("V|A|B|ctr|-|2026-09-01|0.9|moved"),
      },
    );
    expect(readClaimVersion(older.claimId)?.closedBy).not.toBeNull();

    undoRun("run2");
    const restored = readClaimVersion(older.claimId);
    expect(restored?.closedBy).toBeNull();
    expect(restored?.validTo).toBeNull();
    expect(activeClaims().map((c) => c.id)).toEqual([older.claimId]);
  });

  it("leaves a user's own mutation alone", () => {
    const seeded = writeClaim(claim(), { now: NOW, runId: "run1" });
    getDb()
      .prepare(
        `INSERT INTO mutations (id, actor, run_id, target_kind, target_id, field, new_json)
         VALUES ('mut_user','user','run1','claim_version',?, 'text', '"user text"')`,
      )
      .run(seeded.claimId);

    const undone = undoRun("run1");
    expect(undone.skippedUserMutations).toEqual(["mut_user"]);
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM mutations WHERE id = 'mut_user'`).get(),
    ).toEqual({ n: 1 });
  });

  it("is idempotent — a second undo of the same run changes nothing", () => {
    writeClaim(claim(), { now: NOW, runId: "run1" });
    undoRun("run1");
    expect(claimCount()).toBe(0);
    expect(undoRun("run1").reversed).toEqual([]);
  });
});
