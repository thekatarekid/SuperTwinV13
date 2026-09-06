// ===========================================================================
// Extract + Decide pass runners (build P1.4, spec §8.3/§8.4/§6.3) — stubbed
// LLM, real temp DB. What is under test is the CODE around the model:
//
//   extract: subject discipline (unknown beats wrong), evidence-gated claim
//            writes, provisional people, tone; every write a decisions row.
//   decide:  chapters/tasks/closures/plan applied; schedules + follow-ups
//            ACT through the code-side policy gate (P3.1); closure confidence floor
//            (false_auto_close); suggested-task budget; IDEMPOTENT re-run.
//   reduce:  group by space → queue → drain; extract grouped per stream.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { createEntity } from "../entities/registry.js";
import type { Provider, Usage } from "../providers/types.js";
import type { JsonPassDeps } from "./llm.js";
import { runExtractPass } from "./extract-pass.js";
import { runDecidePass, CLOSE_CONFIDENCE_FLOOR } from "./decide-pass.js";
import { runReduce } from "./reduce.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-passes-"));
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

/** Stub provider: answers each call with the next canned text (last repeats). */
function stubProvider(responses: string[]): Provider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: "stub",
    calls,
    cancel: () => false,
    async send(opts) {
      calls.push(opts.message);
      const text = responses[Math.min(calls.length - 1, responses.length - 1)] ?? "{}";
      opts.onEvent({ type: "delta", text });
      opts.onEvent({ type: "done", sessionId: "s", usage: USAGE });
      return { sessionId: "s", usage: USAGE, freshFallback: false, status: "ok" };
    },
  };
}

function deps(provider: Provider): JsonPassDeps {
  return { provider };
}

function seedEpisode(id: string, opts: { spaceId?: string | null; streamId?: string | null; events?: { id: string; text: string }[] } = {}): void {
  const db = getDb();
  db.prepare(`INSERT INTO episodes (id, space_id, stream_id, state, summary) VALUES (?, ?, ?, 'open', ?)`).run(
    id,
    opts.spaceId ?? null,
    opts.streamId ?? null,
    `summary of ${id}`,
  );
  for (const ev of opts.events ?? []) {
    db.prepare(`INSERT INTO events (id, ts, actor, text) VALUES (?, '2026-08-01T10:00:00Z', 'self', ?)`).run(
      ev.id,
      ev.text,
    );
    const rowid = (db.prepare(`SELECT rowid AS r FROM events WHERE id = ?`).get(ev.id) as { r: number }).r;
    db.prepare(
      `INSERT INTO episode_events (id, episode_id, start_event_id, end_event_id, start_rowid, end_rowid)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`ee_${ev.id}`, id, ev.id, ev.id, rowid, rowid);
  }
}

describe("extract pass (extract.v6)", () => {
  it("writes evidence-gated claims, downgrades fabricated subjects to unknown, creates provisional people, updates tone", async () => {
    const rohan = createEntity({ type: "person", canonical: "Rohan", provisional: false });
    seedEpisode("ep_1", { events: [{ id: "e1", text: "window seat pls, pune wala flight" }] });
    const NULLF = { amount: null, currency: null, date: null, status: null, merchant: null, order_id: null, location: null, duration_s: null };

    const provider = stubProvider([
      JSON.stringify({
        claims: [
          {
            kind: "preference",
            subject: rohan.id,
            text: "prefers window seats",
            provenance: "observed",
            fields: NULLF,
            evidence: [{ event_ids: ["e1"], quote: "window seat pls" }],
            confidence: 0.85,
          },
          {
            kind: "fact",
            subject: "ent_totally_made_up",
            text: "lives in Pune",
            provenance: "observed",
            fields: NULLF,
            evidence: [{ event_ids: ["e1"], quote: "pune wala" }],
            confidence: 0.7,
          },
        ],
        people: [{ id: "new:sameer", name: "Sameer", anchors: ["Rohan's cousin"], relationship: null, confidence: 0.6, evidence: [] }],
        tone: [
          {
            scope: `dm:${rohan.id}`,
            register: "casual",
            language_mix: "Hinglish",
            emoji: [],
            phrases: [],
            address_terms: [{ term: "bro", class: "generic", maps_to: null }],
          },
        ],
        feelings: [],
      }),
    ]);

    const result = await runExtractPass(["ep_1"], deps(provider));
    expect(result.status).toBe("ok");
    expect(result.applied.claimsWritten).toBe(2);

    const db = getDb();
    const versions = db
      .prepare(`SELECT subject_id, subject_hint, text FROM claim_versions ORDER BY text`)
      .all() as { subject_id: string | null; subject_hint: string | null; text: string }[];
    const madeUp = versions.find((v) => v.text === "lives in Pune");
    // UNKNOWN BEATS WRONG: the fabricated roster id must NOT survive.
    expect(madeUp?.subject_id).toBeNull();
    expect(madeUp?.subject_hint).toBe("ent_totally_made_up");
    const real = versions.find((v) => v.text === "prefers window seats");
    expect(real?.subject_id).toBe(rohan.id);

    const sameer = db
      .prepare(`SELECT provisional FROM entities WHERE canonical = 'Sameer'`)
      .get() as { provisional: number };
    expect(sameer.provisional).toBe(1);

    const tone = db
      .prepare(`SELECT register, language_mix FROM tone_profiles WHERE person_entity_id = ?`)
      .get(rohan.id) as { register: string; language_mix: string };
    expect(tone).toEqual({ register: "casual", language_mix: "Hinglish" });

    // every model call recorded in runs (traced accounting path)
    const runs = db.prepare(`SELECT role FROM runs WHERE role = 'extract'`).all();
    expect(runs.length).toBeGreaterThan(0);
  });

  it("does nothing (and makes no call) for an empty episode group", async () => {
    const provider = stubProvider(["{}"]);
    const result = await runExtractPass([], deps(provider));
    expect(result.status).toBe("ok");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("decide pass", () => {
  function seedSpace(): void {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status, goal) VALUES ('sp_goa', 'goa dec trip', 'active', 'trip 18-21 dec')`).run();
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, status) VALUES ('tsk_pool', 'sp_goa', 'Pay the pool villa deposit', 'explicit', 'open')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, space_id, title, type, status) VALUES ('tsk_cab', 'sp_goa', 'Book airport cab', 'explicit', 'open')`,
    ).run();
    seedEpisode("ep_412", { spaceId: "sp_goa", events: [{ id: "e1", text: "lets lock goa 18-21 dec" }] });
  }

  const DECIDE_ANSWER = JSON.stringify({
    space: "sp_goa",
    chapters: [{ id: null, label: "Flights", status: "active", episodes: ["ep_412"], target: "2026-08-29" }],
    tasks: [
      {
        title: "Book flights CCU-GOI 18 Dec, return 21 Dec",
        type: "explicit",
        category: "transaction",
        risk_class: "approve-final",
        owner: "self",
        chapter: "Flights",
        due: "2026-08-29",
        evidence: [{ event_ids: ["e1"], quote: "lets lock goa 18-21 dec" }],
        confidence: 0.9,
      },
    ],
    schedules: [{ task: "web check-in", fire_at: "2026-12-16T07:00+05:30", mode: "auto", reason: "opens T-48h" }],
    closures: [
      { task: "tsk_pool", verdict: "close", outcome: "done", reason: "receipt shared", confidence: 0.92 },
      { task: "tsk_cab", verdict: "close", outcome: "done", reason: "said 'paying tonight'", confidence: 0.55 },
    ],
    followups: [{ title: "Shortlist villas", because: "flights booked" }],
    plan: { next: ["flights (awaiting approval)", "villa shortlist"] },
  });

  it("applies chapters/tasks/closures/plan AND activates schedules + follow-ups (P3.1)", async () => {
    seedSpace();
    const provider = stubProvider([DECIDE_ANSWER]);
    const result = await runDecidePass("sp_goa", ["ep_412"], {
      ...deps(provider),
      now: () => new Date("2026-08-29T10:00:00Z"),
    });
    expect(result.status).toBe("ok");
    expect(result.applied.chaptersCreated).toBe(1);
    expect(result.applied.tasksCreated).toBe(1);
    expect(result.applied.tasksClosed).toBe(1); // only the ≥0.85 closure
    expect(result.applied.closeSuggestions).toBe(1); // the 0.55 one proposes
    expect(result.applied.planUpdated).toBe(true);

    const db = getDb();
    const pool = db.prepare(`SELECT status, closed_at FROM tasks WHERE id = 'tsk_pool'`).get() as {
      status: string;
      closed_at: string | null;
    };
    expect(pool.status).toBe("done");
    expect(pool.closed_at).not.toBeNull();
    // The one-sided closure MUTATED NOTHING (false_auto_close = 0).
    const cab = db.prepare(`SELECT status FROM tasks WHERE id = 'tsk_cab'`).get() as { status: string };
    expect(cab.status).toBe("open");
    expect(CLOSE_CONFIDENCE_FLOOR).toBe(0.85);

    // The schedule had no matching task → conservative carrier, CONFIRM only
    // (unknown risk is never auto), and NOTHING went to the deferred pen.
    expect(result.applied.schedulesAuto).toBe(0);
    expect(result.applied.schedulesProposed).toBe(1);
    const carrier = db
      .prepare(`SELECT risk_class, status, schedule_json FROM tasks WHERE title = 'web check-in'`)
      .get() as { risk_class: string; status: string; schedule_json: string };
    expect(carrier.risk_class).toBe("advise-only");
    expect(carrier.status).toBe("open"); // confirm mode never silently schedules
    expect(JSON.parse(carrier.schedule_json)).toMatchObject({ mode: "confirm", proposed: true });
    expect(
      (db.prepare(`SELECT COUNT(*) AS n FROM deferred_outputs WHERE kind IN ('schedule','followup')`).get() as { n: number }).n,
    ).toBe(0);

    // The follow-up became a task with its "because:" spine visible.
    expect(result.applied.followupsCreated).toBe(1);
    const villa = db
      .prepare(`SELECT type, evidence_json, created_by FROM tasks WHERE title = 'Shortlist villas'`)
      .get() as { type: string; evidence_json: string; created_by: string };
    expect(villa.type).toBe("suggested");
    expect(villa.evidence_json).toContain("because: flights booked");
    expect(villa.created_by).toBe("decide_followup");

    // The 'done' closure queued the next-step pass (spec §11.3 trigger b).
    expect(result.applied.nextStepsEnqueued).toBe(1);
    const nextStep = db
      .prepare(`SELECT task_id, status FROM deferred_outputs WHERE kind = 'next_step'`)
      .get() as { task_id: string; status: string };
    expect(nextStep).toEqual({ task_id: "tsk_pool", status: "deferred" });

    const flightTask = db
      .prepare(`SELECT chapter_id, evidence_json FROM tasks WHERE title LIKE 'Book flights%'`)
      .get() as { chapter_id: string | null; evidence_json: string };
    expect(flightTask.chapter_id).not.toBeNull();
    expect(flightTask.evidence_json).toContain("lets lock goa 18-21 dec");

    // every mutation decision-rowed
    const decisions = db.prepare(`SELECT COUNT(*) AS n FROM decisions WHERE pass = 'decide'`).get() as { n: number };
    expect(decisions.n).toBeGreaterThanOrEqual(6);
  });

  it("is idempotent: a second run with the identical answer changes nothing (CHP-06/CON-08)", async () => {
    seedSpace();
    const clock = { now: () => new Date("2026-08-29T10:00:00Z") };
    await runDecidePass("sp_goa", ["ep_412"], { ...deps(stubProvider([DECIDE_ANSWER])), ...clock });
    const db = getDb();
    const snapshot = {
      chapters: (db.prepare(`SELECT COUNT(*) AS n FROM chapters`).get() as { n: number }).n,
      tasks: (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n,
      deferred: (db.prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get() as { n: number }).n,
      plan: (db.prepare(`SELECT plan_json FROM spaces WHERE id = 'sp_goa'`).get() as { plan_json: string }).plan_json,
    };
    const second = await runDecidePass("sp_goa", ["ep_412"], {
      ...deps(stubProvider([DECIDE_ANSWER])),
      ...clock,
    });
    expect(second.applied.chaptersCreated).toBe(0);
    expect(second.applied.tasksCreated).toBe(0);
    expect(second.applied.schedulesAuto).toBe(0);
    expect(second.applied.schedulesProposed).toBe(0);
    expect(second.applied.schedulesSkipped).toBe(1); // carrier already scheduled
    expect(second.applied.followupsCreated).toBe(0);
    expect(second.applied.followupsSkipped).toBe(1); // open by title
    expect(second.applied.nextStepsEnqueued).toBe(0); // tsk_pool already closed
    expect(second.applied.planUpdated).toBe(false);
    expect({
      chapters: (db.prepare(`SELECT COUNT(*) AS n FROM chapters`).get() as { n: number }).n,
      tasks: (db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n,
      deferred: (db.prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get() as { n: number }).n,
      plan: (db.prepare(`SELECT plan_json FROM spaces WHERE id = 'sp_goa'`).get() as { plan_json: string }).plan_json,
    }).toEqual(snapshot);
  });

  it("suggested tasks are marked and UNCAPPED (V6 P1 §14.1 / TSK-02) — dedupe by open title is the only filter", async () => {
    seedSpace();
    const answer = JSON.stringify({
      tasks: [1, 2, 3, 4].map((n) => ({
        title: `Suggested thing ${n}`,
        type: "suggested",
        risk_class: "advise-only",
        owner: "self",
        confidence: 0.6,
      })),
      chapters: [],
      schedules: [],
      closures: [],
      followups: [],
      plan: null,
    });
    const result = await runDecidePass("sp_goa", ["ep_412"], deps(stubProvider([answer])));
    expect(result.applied.tasksCreated).toBe(4);
    expect(result.applied.tasksSkipped).toBe(0);
    const types = getDb().prepare(`SELECT type FROM tasks WHERE title LIKE 'Suggested thing %'`).all() as { type: string }[];
    expect(types).toHaveLength(4);
    for (const t of types) expect(t.type).toBe("suggested");
  });
});

describe("reduce", () => {
  const EMPTY_ANSWER = JSON.stringify({
    claims: [],
    provisional_people: [],
    tone: [],
    chapters: [],
    tasks: [],
    schedules: [],
    closures: [],
    followups: [],
    plan: null,
  });

  it("groups by space into the queue, drains it, and extracts per stream group", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_a', 'a', 'active')`).run();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_b', 'b', 'active')`).run();
    seedEpisode("ep_1", { spaceId: "sp_a", events: [{ id: "e1", text: "hi" }] });
    seedEpisode("ep_2", { spaceId: "sp_a", events: [{ id: "e2", text: "ho" }] });
    seedEpisode("ep_3", { spaceId: "sp_b", events: [{ id: "e3", text: "hu" }] });
    const provider = stubProvider([EMPTY_ANSWER]);
    const report = await runReduce(
      [
        { episodeId: "ep_1", spaceId: "sp_a" },
        { episodeId: "ep_2", spaceId: "sp_a" },
        { episodeId: "ep_3", spaceId: "sp_b" },
        { episodeId: "ep_missing_space", spaceId: null },
      ],
      deps(provider),
    );
    expect(report.enqueuedSpaces).toBe(2);
    expect(report.decided.map((d) => d.spaceId).sort()).toEqual(["sp_a", "sp_b"]);
    expect(report.decided.every((d) => d.result.status === "ok")).toBe(true);
    // queue fully drained
    const left = db.prepare(`SELECT COUNT(*) AS n FROM decide_queue`).get() as { n: number };
    expect(left.n).toBe(0);
  });
});
