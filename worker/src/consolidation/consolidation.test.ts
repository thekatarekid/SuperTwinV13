// ===========================================================================
// Consolidation (build P1.5, spec §9.2/§9.5/§15.2) — stubbed LLM, real DB.
//
//   sweep:     activation sweep attaches by confidence band (≥0.75 attach,
//              0.60–0.75 attach + second_look, else leave), claims unsorted,
//              leaves a marker; a second activation changes nothing (CON-08).
//   t2:        a merge verdict is a merge QUESTION at any confidence (CON-02,
//              false_auto_merge = 0) — the machine never merges; the answered
//              question's apply path (mergeSpaces) moves everything and
//              archives the loser; the hourly roll skips outright when nothing
//              was written (CON-01); dormancy; unsorted archive; second-look
//              confirm/detach with the attach decision REVERSED.
//   reversal:  a merge decision's old_json restores every moved object.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { decisionsFor, writeDecision } from "../db/decisions.js";
import type { ProviderV2, Usage } from "../providers/types.js";
import { providerRequestText, providerV2TestDouble } from "../providers/test-support.js";
import type { JsonPassDeps } from "../brain/llm.js";
import { attachEpisode, sweepSpaceOnActivation, unsweptActiveSpaces } from "./sweep.js";
import { mergeSpaces, runT2, mergeQuestionId, T2_LAST_ROLL_KEY } from "./t2.js";
import { appStateSet } from "../db/ingest.js";
import { reverseDecision } from "./reversal.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-con-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const USAGE: Usage = {
  inputTokens: 10,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 5,
};

function stubProvider(responses: string[]): ProviderV2 & { calls: string[] } {
  const calls: string[] = [];
  return Object.assign(providerV2TestDouble(async (opts) => {
      calls.push(providerRequestText(opts));
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", continuation: null, usage: USAGE });
      return { continuation: null, usage: USAGE, freshFallback: false, status: "ok" };
  }), { calls });
}

function deps(provider: ProviderV2): JsonPassDeps {
  return { provider };
}

function seedSpace(id: string, label: string, status = "active"): void {
  getDb().prepare(`INSERT INTO spaces (id, label, status, goal) VALUES (?, ?, ?, 'a goal')`).run(id, label, status);
}

function seedUnsortedEpisode(epId: string, summary: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO episodes (id, state, summary) VALUES (?, 'open', ?)`).run(epId, summary);
  db.prepare(`INSERT INTO unsorted (id, episode_id, reason) VALUES (?, ?, 'low confidence')`).run(`uns_${epId}`, epId);
}

describe("activation sweep", () => {
  it("attaches by confidence band, claims unsorted, queues second-look, and is idempotent", async () => {
    seedSpace("sp_goa", "goa dec trip");
    seedUnsortedEpisode("ep_hi", "flight prices CCU-GOI");
    seedUnsortedEpisode("ep_mid", "villa options in anjuna");
    seedUnsortedEpisode("ep_no", "office standup notes");

    const answer = JSON.stringify({
      attachments: [
        { episode: "ep_hi", attach: true, confidence: 0.9, reason: "same trip" },
        { episode: "ep_mid", attach: true, confidence: 0.65, reason: "probably the trip" },
        { episode: "ep_no", attach: false, confidence: 0.2, reason: "unrelated" },
      ],
    });
    const report = await sweepSpaceOnActivation("sp_goa", deps(stubProvider([answer])));
    expect(report.swept).toBe(true);
    expect(report.candidates).toBe(3);
    expect(report.attached).toBe(2);
    expect(report.secondLook).toBe(1);

    const db = getDb();
    const spaces = db
      .prepare(`SELECT id, space_id FROM episodes ORDER BY id`)
      .all() as { id: string; space_id: string | null }[];
    expect(spaces).toEqual([
      { id: "ep_hi", space_id: "sp_goa" },
      { id: "ep_mid", space_id: "sp_goa" },
      { id: "ep_no", space_id: null },
    ]);
    const unsorted = db
      .prepare(`SELECT episode_id, status FROM unsorted ORDER BY episode_id`)
      .all() as { episode_id: string; status: string }[];
    expect(unsorted).toEqual([
      { episode_id: "ep_hi", status: "claimed" },
      { episode_id: "ep_mid", status: "claimed" },
      { episode_id: "ep_no", status: "open" },
    ]);
    const secondLook = db
      .prepare(`SELECT episode_id, status FROM second_look`)
      .all() as { episode_id: string; status: string }[];
    expect(secondLook).toEqual([{ episode_id: "ep_mid", status: "pending" }]);

    // attaches are reversible decisions
    expect(decisionsFor("episode", "ep_hi").some((d) => d.action === "attach")).toBe(true);

    // the marker makes activation idempotent: no second call, no changes
    expect(unsweptActiveSpaces()).toEqual([]);
    const again = await sweepSpaceOnActivation("sp_goa", deps(stubProvider([answer])));
    expect(again.swept).toBe(false);
    expect(again.candidates).toBe(0);
  });

  it("ignores episode ids the model invented (never offered as candidates)", async () => {
    seedSpace("sp_x", "some space");
    seedUnsortedEpisode("ep_real", "real candidate");
    getDb().prepare(`INSERT INTO episodes (id, state) VALUES ('ep_foreign', 'open')`).run();
    const answer = JSON.stringify({
      attachments: [
        { episode: "ep_foreign", attach: true, confidence: 0.99, reason: "made up" },
        { episode: "ep_real", attach: false, confidence: 0.3 },
      ],
    });
    const report = await sweepSpaceOnActivation("sp_x", deps(stubProvider([answer])));
    expect(report.attached).toBe(0);
    const foreign = getDb().prepare(`SELECT space_id FROM episodes WHERE id = 'ep_foreign'`).get() as {
      space_id: string | null;
    };
    expect(foreign.space_id).toBeNull();
  });
});

describe("t2 consolidation", () => {
  it("a 0.95 merge verdict on a flagged pair is a merge QUESTION, never a silent merge (CON-02)", async () => {
    const db = getDb();
    seedSpace("sp_a", "goa trip");
    seedSpace("sp_b", "goa trip");
    db.prepare(`INSERT INTO episodes (id, space_id, state) VALUES ('ep_b1', 'sp_b', 'open')`).run();
    db.prepare(`INSERT INTO tasks (id, space_id, title, status) VALUES ('tsk_b1', 'sp_b', 'book cab', 'open')`).run();
    db.prepare(
      `INSERT INTO t2_review_queue (id, kind, space_id, overlap_space_id) VALUES ('flag_1', 'flag_overlap', 'sp_a', 'sp_b')`,
    ).run();

    const verdict = JSON.stringify({
      verdict: "merge",
      survivor: "sp_a",
      confidence: 0.95,
      reason: "same trip tracked twice",
    });
    const provider = stubProvider([verdict]);
    const report = await runT2(deps(provider), { flagsOnly: true });
    expect(report.flagsProcessed).toBe(1);
    expect(report.merged).toBe(0);
    expect(report.mergeSuggestions).toBe(1);
    expect(report.modelCalls).toBe(1);

    // nothing moved, nothing archived
    expect((db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_b1'`).get() as { space_id: string }).space_id).toBe("sp_b");
    expect((db.prepare(`SELECT space_id FROM tasks WHERE id = 'tsk_b1'`).get() as { space_id: string }).space_id).toBe("sp_b");
    expect((db.prepare(`SELECT status FROM spaces WHERE id = 'sp_b'`).get() as { status: string }).status).toBe("active");
    expect((db.prepare(`SELECT status FROM t2_review_queue WHERE id = 'flag_1'`).get() as { status: string }).status).toBe("done");

    // the question: a suggest_merge decision AND an open questions row
    expect(decisionsFor("space", "sp_b").some((d) => d.action === "suggest_merge")).toBe(true);
    const q = db.prepare(`SELECT kind, target_id, status, question FROM questions WHERE id = ?`).get(mergeQuestionId("sp_a", "sp_b")) as {
      kind: string; target_id: string; status: string; question: string;
    };
    expect(q.kind).toBe("merge");
    expect(q.status).toBe("open");
    expect(q.question).toContain("goa trip");

    // idempotent: nothing pending, second run changes nothing (IDEM-01)
    const again = await runT2(deps(stubProvider([verdict])), { flagsOnly: true });
    expect(again.flagsProcessed + again.merged + again.mergeSuggestions).toBe(0);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM questions`).get() as { n: number }).n).toBe(1);
  });

  it("the answered question's apply path (mergeSpaces) moves everything, archives the loser, deletes nothing", () => {
    const db = getDb();
    seedSpace("sp_a", "goa trip");
    seedSpace("sp_b", "goa trip");
    db.prepare(`INSERT INTO episodes (id, space_id, state) VALUES ('ep_b1', 'sp_b', 'open')`).run();
    db.prepare(`INSERT INTO tasks (id, space_id, title, status) VALUES ('tsk_b1', 'sp_b', 'book cab', 'open')`).run();
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n;
    expect(mergeSpaces("sp_a", "sp_b", null, "user answered merge", 1)).not.toBeNull();
    expect((db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_b1'`).get() as { space_id: string }).space_id).toBe("sp_a");
    expect((db.prepare(`SELECT space_id FROM tasks WHERE id = 'tsk_b1'`).get() as { space_id: string }).space_id).toBe("sp_a");
    expect((db.prepare(`SELECT status FROM spaces WHERE id = 'sp_b'`).get() as { status: string }).status).toBe("archived");
    expect((db.prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(before);
    // a second apply is a no-op (the loser is already archived)
    expect(mergeSpaces("sp_a", "sp_b", null, null, null)).toBeNull();
  });

  it("the hourly roll skips outright — zero calls — when nothing was written since the last roll (CON-01)", async () => {
    const db = getDb();
    seedSpace("sp_a", "goa trip");
    seedSpace("sp_b", "goa trip"); // a near-duplicate the judge WOULD be asked about
    // The last roll happened after every write above.
    appStateSet(T2_LAST_ROLL_KEY, new Date(Date.now() + 1_000).toISOString());
    const provider = stubProvider([JSON.stringify({ verdict: "merge", survivor: "sp_a", confidence: 0.99 })]);
    const report = await runT2(deps(provider));
    expect(report.rollSkipped).toBe(true);
    expect(report.changedRows).toBe(0);
    expect(report.modelCalls).toBe(0);
    expect(provider.calls).toEqual([]);
    expect((db.prepare(`SELECT COUNT(*) AS n FROM questions`).get() as { n: number }).n).toBe(0);

    // A write since the last roll wakes it: the touched pair is judged once.
    appStateSet(T2_LAST_ROLL_KEY, new Date(Date.now() - 1_000).toISOString());
    db.prepare(`INSERT INTO episodes (id, space_id, state) VALUES ('ep_a1', 'sp_a', 'open')`).run();
    const woke = await runT2(deps(provider));
    expect(woke.rollSkipped).toBe(false);
    expect(woke.changedRows).toBeGreaterThan(0);
    expect(woke.modelCalls).toBe(1);
    expect(woke.mergeSuggestions).toBe(1);
    expect(woke.merged).toBe(0);
  });

  it("rolls dormancy and the unsorted archive, idempotently, with reversible decisions", async () => {
    const db = getDb();
    const old = "2026-01-01T00:00:00.000Z";
    seedSpace("sp_old", "stale space");
    db.prepare(`UPDATE spaces SET created_at = ?, updated_at = ? WHERE id = 'sp_old'`).run(old, old);
    seedUnsortedEpisode("ep_stale", "old unsorted");
    db.prepare(`UPDATE unsorted SET created_at = ? WHERE episode_id = 'ep_stale'`).run(old);

    const report = await runT2(deps(stubProvider(["{}"])));
    expect(report.dormant).toBe(1);
    expect(report.unsortedArchived).toBe(1);
    expect((db.prepare(`SELECT status FROM spaces WHERE id = 'sp_old'`).get() as { status: string }).status).toBe("dormant");
    expect((db.prepare(`SELECT status FROM unsorted WHERE episode_id = 'ep_stale'`).get() as { status: string }).status).toBe("archived");

    const again = await runT2(deps(stubProvider(["{}"])));
    expect(again.dormant).toBe(0);
    expect(again.unsortedArchived).toBe(0);
  });

  it("second look: an unconfirmed 0.60-0.75 attach is detached by REVERSING the attach decision", async () => {
    const db = getDb();
    seedSpace("sp_goa", "goa dec trip");
    seedUnsortedEpisode("ep_mid", "villa options");
    attachEpisode("sp_goa", "ep_mid", 0.65, "probably", null);
    db.prepare(
      `INSERT INTO second_look (id, episode_id, space_id, attach_confidence) VALUES ('sl_1', 'ep_mid', 'sp_goa', 0.65)`,
    ).run();

    const answer = JSON.stringify({
      attachments: [{ episode: "ep_mid", attach: false, confidence: 0.3, reason: "different villa hunt" }],
    });
    const report = await runT2(deps(stubProvider([answer])));
    expect(report.secondLookDetached).toBe(1);

    expect((db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_mid'`).get() as { space_id: string | null }).space_id).toBeNull();
    expect((db.prepare(`SELECT status FROM unsorted WHERE episode_id = 'ep_mid'`).get() as { status: string }).status).toBe("open");
    expect((db.prepare(`SELECT status FROM second_look WHERE id = 'sl_1'`).get() as { status: string }).status).toBe("detached");
    const attach = decisionsFor("episode", "ep_mid").find((d) => d.action === "attach");
    expect(attach?.reversedAt).not.toBeNull();
    expect(decisionsFor("episode", "ep_mid").some((d) => d.action === "detach")).toBe(true);
  });

  it("second look: a confirmed attach stays and the row resolves", async () => {
    const db = getDb();
    seedSpace("sp_goa", "goa dec trip");
    seedUnsortedEpisode("ep_mid", "villa options");
    attachEpisode("sp_goa", "ep_mid", 0.7, "probably", null);
    db.prepare(
      `INSERT INTO second_look (id, episode_id, space_id, attach_confidence) VALUES ('sl_1', 'ep_mid', 'sp_goa', 0.7)`,
    ).run();
    const answer = JSON.stringify({
      attachments: [{ episode: "ep_mid", attach: true, confidence: 0.85, reason: "definitely the trip" }],
    });
    const report = await runT2(deps(stubProvider([answer])));
    expect(report.secondLookConfirmed).toBe(1);
    expect((db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_mid'`).get() as { space_id: string }).space_id).toBe("sp_goa");
    expect((db.prepare(`SELECT status FROM second_look WHERE id = 'sl_1'`).get() as { status: string }).status).toBe("confirmed");
  });
});

describe("reversal", () => {
  it("restores a merge from its decision row: episodes, tasks and the loser's status", () => {
    const db = getDb();
    seedSpace("sp_a", "goa trip");
    seedSpace("sp_b", "goa trip");
    db.prepare(`INSERT INTO episodes (id, space_id, state) VALUES ('ep_b1', 'sp_b', 'open')`).run();
    db.prepare(`INSERT INTO tasks (id, space_id, title, status) VALUES ('tsk_b1', 'sp_b', 'book cab', 'open')`).run();
    mergeSpaces("sp_a", "sp_b", null, "dup", 0.95);
    expect((db.prepare(`SELECT status FROM spaces WHERE id = 'sp_b'`).get() as { status: string }).status).toBe("archived");

    const merge = decisionsFor("space", "sp_b").find((d) => d.action === "merge");
    expect(merge).toBeDefined();
    expect(reverseDecision(merge!, "test")).toBe(true);

    expect((db.prepare(`SELECT status FROM spaces WHERE id = 'sp_b'`).get() as { status: string }).status).toBe("active");
    expect((db.prepare(`SELECT space_id FROM episodes WHERE id = 'ep_b1'`).get() as { space_id: string }).space_id).toBe("sp_b");
    expect((db.prepare(`SELECT space_id FROM tasks WHERE id = 'tsk_b1'`).get() as { space_id: string }).space_id).toBe("sp_b");
    // a reversed decision cannot be reversed twice
    const after = decisionsFor("space", "sp_b").find((d) => d.action === "merge");
    expect(reverseDecision(after!, "test")).toBe(false);
  });

  it("restores a closed task and refuses unknown (kind, action) pairs", () => {
    const db = getDb();
    seedSpace("sp_a", "a");
    db.prepare(`INSERT INTO tasks (id, space_id, title, status) VALUES ('tsk_1', 'sp_a', 't', 'open')`).run();
    db.prepare(`UPDATE tasks SET status = 'done', closed_at = '2026-08-28T00:00:00Z' WHERE id = 'tsk_1'`).run();
    writeDecision({
      pass: "decide",
      targetKind: "task",
      targetId: "tsk_1",
      action: "close",
      old: { status: "open" },
      new: { status: "done" },
    });
    const close = decisionsFor("task", "tsk_1").find((d) => d.action === "close");
    expect(reverseDecision(close!, "test")).toBe(true);
    expect((db.prepare(`SELECT status, closed_at FROM tasks WHERE id = 'tsk_1'`).get() as { status: string; closed_at: string | null })).toEqual({ status: "open", closed_at: null });

    writeDecision({ pass: "x", targetKind: "widget", targetId: "w1", action: "explode", old: {}, new: {} });
    const unknown = decisionsFor("widget", "w1")[0];
    expect(reverseDecision(unknown, "test")).toBe(false);
  });
});
