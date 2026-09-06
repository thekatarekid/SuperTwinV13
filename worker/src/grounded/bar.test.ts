// ===========================================================================
// One bar turn (V6 P1 S5.5; Product_V6_Phase1 §19; BAR-03..10). Every model
// seam is injected, so this suite makes ZERO live calls and still runs the
// real pipeline: route → the five methods → RRF → reranker → judge →
// sufficiency in code → the cited answer, and the action / correction /
// general branches beside it.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Kolkata";
const tmpRoot = mkdtempSync(join(tmpdir(), "st-bar-turn-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { appendEvent } = await import("../db/eventlog.js");
const { noteCaptured } = await import("../coverage/index.js");
const { setClaimTypedFields, SELF_ENTITY_ID } = await import("../db/v6graph.js");
const { writeClaimVersion } = await import("../claims/store.js");
const { routeHeuristic } = await import("../prompts/route.v1.js");
const { chipsForLock, isBareFragment, matchOption, runBarTurn } = await import("./bar.js");
import type { BarDeps, BarLockRef } from "./bar.js";
import type { JudgeOutput } from "../prompts/judge.v1.js";

const NOW = new Date("2026-09-05T04:30:00.000Z");

let seq = 0;

function ev(text: string, opts: { streamKey?: string; actor?: string; ts?: string } = {}): string {
  seq += 1;
  const { id } = appendEvent({
    ts: opts.ts ?? new Date(NOW.getTime() - seq * 3_600_000).toISOString(),
    source: "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: opts.streamKey ?? "wa:goa-gang",
    actor: opts.actor ?? "contact:rohan",
    roles: { sender: opts.actor ?? "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  });
  return id;
}

function receipt(merchant: string, amount: number, date: string): void {
  seq += 1;
  const key = `claim_${seq}`;
  const text = `Paid ₹${amount} to ${merchant}`;
  writeClaimVersion({
    claimKey: key,
    kind: "fact",
    subjectId: SELF_ENTITY_ID,
    text,
    confidence: 0.95,
    statedAt: `${date}T10:00:00.000Z`,
    evidence: [{ event_ids: [], quote: text }],
    decidedBy: "test",
  });
  setClaimTypedFields(key, { merchant, amount, currency: "INR", date });
}

/** A judge that quotes the passage it was given — verbatim, as the contract asks. */
const quoteFirst =
  (n = 1) =>
  async (_q: string, passages: readonly { id: string; text: string }[]): Promise<JudgeOutput> => ({
    results: passages.slice(0, n).map((p) => ({ id: p.id, quote: p.text.slice(0, 14), why: "answers it" })),
    answer: passages.length > 0 ? "₹6k max per night — you said so on Aug 24" : null,
    dropped: [],
  });

const NO_JUDGE = async (): Promise<JudgeOutput> => ({ results: [], answer: null, dropped: [] });

function deps(over: BarDeps = {}): BarDeps {
  return { reranker: null, judge: NO_JUDGE, ...over };
}

/** The planner the bar would have got from route.v1, without the call. */
const heuristicPlanner = async (text: string, now: Date) => routeHeuristic(text, now);

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec(
    `DELETE FROM claims; DELETE FROM claim_versions; DELETE FROM events; DELETE FROM decisions;
     DELETE FROM tasks; DELETE FROM chapters; DELETE FROM spaces; DELETE FROM coverage; DELETE FROM corrections;`,
  );
  seq = 0;
});

// ---------------------------------------------------------------------------

describe("BAR-03 — a lookup answer cites hard", () => {
  it("answers from the judged quotes, with event citations that resolve", async () => {
    const evId = ev("max 6k a night yaar for the anjuna villa");
    const turn = await runBarTurn(
      { text: "how much per night?", threadId: "th_1", now: NOW },
      deps({ planner: heuristicPlanner, judge: quoteFirst(1), resolveCitation: (id) => id === evId }),
    );
    expect(turn.intent).toBe("question");
    expect(turn.class).toBe("lookup");
    expect(turn.answer!.grounded).toBe(true);
    expect(turn.answer!.refused_uncited).toBe(false);
    expect(turn.answer!.citations).toHaveLength(1);
    expect(turn.answer!.citations[0]!.id).toBe(evId);
    expect(turn.answer!.results[0]!.quote).toBe("max 6k a night");
    // route (stubbed planner) + judge — two seams, both injected.
    expect(turn.model_calls).toBe(2);
  });

  it("refuses prose the judge could not pin to a passage (uncited_claim = 0)", async () => {
    ev("max 6k a night yaar for the anjuna villa");
    const turn = await runBarTurn(
      { text: "how much per night?", threadId: "th_1", now: NOW },
      deps({
        planner: heuristicPlanner,
        judge: async () => ({ results: [], answer: "I remember it being ₹8k a night", dropped: [] }),
      }),
    );
    expect(turn.answer!.grounded).toBe(false);
    expect(turn.answer!.refused_uncited).toBe(true);
    expect(turn.answer!.citations).toEqual([]);
    expect(turn.answer!.answer).not.toContain("8k");
  });

  it("a citation the resolver cannot resolve never reaches the user", async () => {
    ev("max 6k a night yaar for the anjuna villa");
    const turn = await runBarTurn(
      { text: "how much per night?", threadId: "th_1", now: NOW },
      deps({ planner: heuristicPlanner, judge: quoteFirst(1), resolveCitation: () => false }),
    );
    expect(turn.answer!.citations).toEqual([]);
  });
});

describe("BAR-04 — an aggregate is never answered from the top-k", () => {
  it("reports the structured method and the exact value, with no judge call", async () => {
    receipt("Uber", 340, "2026-08-03");
    receipt("Uber", 280, "2026-08-14");
    receipt("Uber", 400, "2026-08-27");
    let judgeCalls = 0;
    const turn = await runBarTurn(
      { text: "how much did I spend on cabs last month", threadId: "th_1", now: NOW },
      deps({
        planner: heuristicPlanner,
        judge: async () => {
          judgeCalls += 1;
          return { results: [], answer: null, dropped: [] };
        },
      }),
    );
    expect(turn.class).toBe("aggregate");
    expect(turn.answer!.method).toBe("structured");
    expect(turn.answer!.value).toBe(1020);
    expect(turn.answer!.answer).toContain("1,020");
    expect(turn.answer!.methods_ran).toContain("structured");
    expect(judgeCalls).toBe(0);
    expect(turn.model_calls).toBe(1);
  });
});

describe("BAR-05 — an absence answer states what it scanned, with the coverage caveat", () => {
  it("no payment found, over a complete scan of the named thread", async () => {
    for (let i = 0; i < 9; i += 1) ev(`goa gang chatter ${i}`, { streamKey: "wa:goa-gang" });
    noteCaptured("wa", ["2026-07-04T10:00:00.000Z", "2026-08-01T10:00:00.000Z"]);
    const planner = async (text: string, now: Date) => ({
      ...routeHeuristic(text, now),
      filters: { stream: "wa:goa-gang" },
      time: { from: "2026-07-01T00:00:00.000Z", to: NOW.toISOString() },
    });
    const turn = await runBarTurn(
      { text: "did karan ever pay the advance", threadId: "th_1", now: NOW },
      deps({ planner }),
    );
    expect(turn.class).toBe("absence");
    expect(turn.answer!.method).toBe("time_window");
    expect(turn.answer!.scanned).toBe(9);
    expect(turn.answer!.answer).toContain("no ");
    expect(turn.answer!.answer).toContain("wa:goa-gang");
    expect(turn.answer!.coverage_caveat).toBe("I only have WhatsApp back to Jul 2026");
    expect(turn.answer!.partial).toBe(false);
  });

  it("a scan that was cut refuses to call it a no", async () => {
    for (let i = 0; i < 9; i += 1) ev(`goa gang chatter ${i}`, { streamKey: "wa:goa-gang" });
    const planner = async (text: string, now: Date) => ({
      ...routeHeuristic(text, now),
      completeness: "topk" as const,
      filters: { stream: "wa:goa-gang" },
      time: { from: "2026-07-01T00:00:00.000Z", to: NOW.toISOString() },
    });
    // The scan cap for a non-exhaustive absence is 500; force the cut by
    // asking sufficiency about a window it could not finish.
    const turn = await runBarTurn({ text: "did karan ever pay the advance", threadId: "th_1", now: NOW }, deps({ planner }));
    expect(turn.answer!.scanned).toBeGreaterThan(0);
    expect(turn.answer!.grounded).toBe(false);
  });
});

describe("BAR-07 — a general answer is labelled, and costs no retrieval", () => {
  it('answers from general knowledge, tagged "Not from your data"', async () => {
    ev("max 6k a night yaar for the anjuna villa");
    const turn = await runBarTurn(
      { text: "gst on hotel rooms", threadId: "th_1", now: NOW },
      deps({ planner: heuristicPlanner, general: async () => "12% under ₹7,500 a night, 18% above." }),
    );
    expect(turn.class).toBe("general");
    expect(turn.answer!.not_from_your_data).toBe(true);
    expect(turn.answer!.answer.startsWith("Not from your data — ")).toBe(true);
    expect(turn.answer!.citations).toEqual([]);
    expect(turn.answer!.methods_ran).toEqual([]);
    expect(turn.answer!.grounded).toBe(false);
  });
});

describe("BAR-08 / BAR-09 — the bar creates now, and the thread locks to what it made", () => {
  const actionCall = async () =>
    JSON.stringify({
      verb: "create_space",
      title: "Hampi trek Oct",
      goal: "plan the october hampi trek",
      risky: false,
      chapters: ["Travel"],
      first_tasks: ["book train"],
    });

  it("creates the named thing immediately and locks the thread to it", async () => {
    const turn = await runBarTurn(
      { text: "plan hampi trek in october, tanvi's coming, budget 15k, she's vegetarian", threadId: "th_1", now: NOW },
      deps({ planner: heuristicPlanner, actionCall }),
    );
    expect(turn.intent).toBe("action");
    expect(turn.action!.status).toBe("done");
    const space = getDb().prepare(`SELECT * FROM spaces WHERE id = ?`).get(turn.action!.space_id!) as {
      status: string;
      created_by: string;
      label: string;
    };
    expect(space.status).toBe("active");
    expect(space.created_by).toBe("user");
    expect(turn.lock).toEqual({ kind: "space", id: turn.action!.space_id, label: "Hampi trek Oct" });
    expect(turn.chips.map((c) => c.label)).toContain("Merge into…");
  });

  it("BAR-09 — a follow-up in the locked thread updates the SAME object, no second space", async () => {
    const first = await runBarTurn(
      { text: "plan hampi trek in october", threadId: "th_1", now: NOW },
      deps({ planner: heuristicPlanner, actionCall }),
    );
    const lock = first.lock!;
    const second = await runBarTurn(
      { text: "actually make it november", threadId: "th_1", lock, now: NOW },
      deps({
        planner: heuristicPlanner,
        correctionParser: async () => ({ type: "edit", field: "label", value: "Hampi trek Nov" }),
      }),
    );
    expect(second.intent).toBe("correction");
    expect(second.lock).toEqual(lock);
    const spaces = getDb().prepare(`SELECT id, label FROM spaces`).all() as { id: string; label: string }[];
    expect(spaces).toHaveLength(1);
    expect(spaces[0]!.label).toBe("Hampi trek Nov");
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM corrections`).get() as { n: number }).n).toBe(1);
  });

  it("an unlocked correction is pointed at Tell the twin, never at a guessed target", async () => {
    const turn = await runBarTurn(
      { text: "this is karan's task, not mine", threadId: "th_1", now: NOW },
      deps({ planner: heuristicPlanner }),
    );
    expect(turn.intent).toBe("correction");
    expect(turn.summary).toContain("Tell the twin");
    expect(turn.lock).toBeNull();
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM corrections`).get() as { n: number }).n).toBe(0);
  });
});

describe("BAR-10 — ambiguity", () => {
  it("an instruction with two candidates asks ONE question with one-tap answers", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_a', 'Goa Dec', 'active')`).run();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_b', 'Goa wedding', 'active')`).run();
    const turn = await runBarTurn(
      { text: "book it", threadId: "th_1", now: NOW },
      deps({
        planner: async (t, n) => ({ ...routeHeuristic(t, n), class: "action" as const }),
        actionCall: async () => JSON.stringify({ verb: "create_task", title: "book it", space_candidates: ["sp_a", "sp_b"], risky: false }),
      }),
    );
    expect(turn.action!.status).toBe("needs_input");
    expect(turn.action!.options).toHaveLength(2);
    expect(turn.action!.question).toBeTruthy();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n).toBe(0);
  });

  it("the next line answers that question — by label, for zero calls", async () => {
    const db = getDb();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_a', 'Goa Dec', 'active')`).run();
    db.prepare(`INSERT INTO spaces (id, label, status) VALUES ('sp_b', 'Hampi trek', 'active')`).run();
    const asked = await runBarTurn(
      { text: "book it", threadId: "th_1", now: NOW },
      deps({
        planner: async (t, n) => ({ ...routeHeuristic(t, n), class: "action" as const }),
        actionCall: async () => JSON.stringify({ verb: "create_task", title: "book it", space_candidates: ["sp_a", "sp_b"], risky: false }),
      }),
    );
    const answer = await runBarTurn(
      {
        text: "goa",
        threadId: "th_1",
        pending: { question: asked.action!.question!, options: asked.action!.options!, action: asked.action!.pending! },
        now: NOW,
      },
      deps({ planner: heuristicPlanner }),
    );
    expect(answer.action!.status).toBe("done");
    expect(answer.model_calls).toBe(0);
    const task = db.prepare(`SELECT space_id FROM tasks WHERE id = ?`).get(answer.action!.task_id!) as { space_id: string };
    expect(task.space_id).toBe("sp_a");
  });

  it("a bare question defaults to search — local results, nothing spent", async () => {
    ev("anjuna goa villa with a pool");
    let routed = 0;
    const turn = await runBarTurn(
      { text: "goa", threadId: "th_1", now: NOW },
      deps({
        planner: async (t, n) => {
          routed += 1;
          return routeHeuristic(t, n);
        },
      }),
    );
    expect(turn.intent).toBe("search");
    expect(turn.model_calls).toBe(0);
    expect(routed).toBe(0);
    expect(turn.search!.events.length).toBeGreaterThan(0);
  });

  it("isBareFragment knows a subject from a correction", () => {
    expect(isBareFragment("goa")).toBe(true);
    expect(isBareFragment("anjuna villa")).toBe(true);
    expect(isBareFragment("book it")).toBe(false);
    expect(isBareFragment("that's wrong")).toBe(false);
    expect(isBareFragment("not mine")).toBe(false);
    expect(isBareFragment("how much per night?")).toBe(false);
    expect(isBareFragment("what happened tuesday afternoon")).toBe(false);
  });

  it("matchOption resolves by id, exact label and unambiguous fragment only", () => {
    const options = [
      { id: "sp_a", label: "Goa Dec" },
      { id: "sp_b", label: "Hampi trek" },
    ];
    expect(matchOption("sp_b", options)!.id).toBe("sp_b");
    expect(matchOption("Goa Dec", options)!.id).toBe("sp_a");
    expect(matchOption("hampi", options)!.id).toBe("sp_b");
    expect(matchOption("nothing", options)).toBeNull();
    expect(matchOption("", options)).toBeNull();
  });
});

describe("quick chips (Product_V6_Phase1 §21)", () => {
  it("offers the chips that belong to the locked kind, and none that do not", () => {
    const task: BarLockRef = { kind: "task", id: "t_1", label: "book the court" };
    expect(chipsForLock(task).map((c) => c.label)).toEqual(["Not mine", "Already done"]);
    expect(chipsForLock({ kind: "claim", id: "c_1", label: "budget ₹15k" }).map((c) => c.label)).toEqual(["Not true", "Outdated"]);
    expect(chipsForLock(null)).toEqual([]);
    expect(chipsForLock({ kind: "episode", id: "ep_1", label: "…" })).toEqual([]);
  });
});
