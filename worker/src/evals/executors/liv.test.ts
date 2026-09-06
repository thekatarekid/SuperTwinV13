// ===========================================================================
// LIV executor (V6 P1 S4.1 + S4.4): the seven code cases run against the real
// fixtures in evals/v13 through the real live tick — recorded live output,
// pinned clock, zero model calls, sandboxed DB. The live lane runs Build
// §7.3's two-call fallback here as it does in production, so each case spends
// one understanding call and one decide call on the same canned answer.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { setConsentGateMode } from "../../db/consent-gate.js";
import { loadFixture } from "../fixtures.js";
import { liveExecutor } from "./liv.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-liv-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  setConsentGateMode("open");
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

type Out = {
  tick: { status: string; lane: string };
  live: { prepared: { persisted: number; cards: number; shelved: number; droppedUngrounded: number }; understandingRejected: number; decide: { tasksCreated: number } } | null;
  prepared: Array<{ kind: string; action: string; urgency: string; deadline_at: string | null; surface: string; grounded: string[]; task: string | null; space: string | null; intent_confidence: number }>;
  episodes: Array<{ id: string; space_id: string | null; members: string[] }>;
  tasks: Array<{ id: string; title: string; status: string; schedule_json: string | null }>;
  decisions: string[];
  decide_queued: string[];
};

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("live");
  const r = await liveExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  // the canned answers never reach the ledger
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  // the case cleaned up after itself
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get() as { n: number }).n).toBe(0);
  return { r, out: r.output as Out };
}

describe("live executor (LIV-01..07)", () => {
  it("LIV-01: the villa sentence — needs_you · today · 17:00+05:30 · e1 · t_88; e1 joins ep_611 in sp_goa_dec", async () => {
    const { r, out } = await run("LIV-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(out.tick.status).toBe("committed");
    expect(out.prepared).toHaveLength(1);
    expect(out.prepared[0]).toMatchObject({ kind: "needs_you", action: "question", urgency: "today", surface: "card", grounded: ["e1"], task: "t_88", space: "sp_goa_dec" });
    expect(Date.parse(out.prepared[0]!.deadline_at!)).toBe(Date.parse("2026-09-05T17:00:00+05:30"));
    expect(out.episodes.find((e) => e.id === "ep_611")).toMatchObject({ space_id: "sp_goa_dec" });
    expect(out.episodes.find((e) => e.id === "ep_611")!.members).toContain("e1");
    expect(r.metrics).toMatchObject({ canned_live_answers: 1, canned_critic_answers: 1, prepared_cards: 1, assist_from_history: 0, nudge_without_grounding: 0 });
    expect(out.decisions).toContain("prepare");
    // the decide half's non-prepared items apply too: the reminder lands on t_88
    const t88 = out.tasks.find((t) => t.id === "t_88")!;
    expect(t88.status).not.toBe("done");
    expect(Date.parse(JSON.parse(t88.schedule_json!).fire_at)).toBe(Date.parse("2026-09-05T16:40:00+05:30"));
  });

  it("LIV-02: history never nudges — the episode commits, zero prepared rows, the live half never runs", async () => {
    const { r, out } = await run("LIV-02");
    expect(r.violations).toEqual([]);
    expect(out.tick).toEqual({ status: "committed", lane: "history" });
    expect(out.live).toBeNull();
    expect(out.prepared).toEqual([]);
    expect(r.metrics!.assist_from_history).toBe(0);
    expect(r.gateObservations).toContainEqual({ gateId: "assist_from_history", passed: true, counted: true });
    // the episode still commits and the space is queued for the per-space
    // decide pass — where the closure check for h4 is decided
    expect(out.episodes.find((e) => e.id === "ep_611")!.members).toContain("e1");
    expect(out.decide_queued).toEqual(["sp_goa_dec"]);
  });

  it("LIV-03: grounding is this flush — an action grounded only in old context is dropped", async () => {
    const { r, out } = await run("LIV-03");
    expect(r.violations).toEqual([]);
    expect(out.prepared).toEqual([]);
    expect(out.live?.prepared.droppedUngrounded).toBe(1);
    expect(out.decisions).toContain("drop_ungrounded_prepared");
    expect(r.metrics!.nudge_without_grounding).toBe(0);
  });

  it("LIV-04: bad decide JSON — the understanding commits on the first call; decide is logged and dropped", async () => {
    const { r, out } = await run("LIV-04");
    expect(r.violations).toEqual([]);
    expect(out.tick.status).toBe("committed");
    expect(r.metrics!.canned_live_answers).toBe(1); // no repair round
    expect(out.prepared).toEqual([]);
    expect(out.live?.decide.tasksCreated).toBe(0);
    expect(out.decisions).toContain("drop_decide");
  });

  it("LIV-05: bad understanding JSON — the malformed item is quarantined alone; the valid one commits; decide runs", async () => {
    const { r, out } = await run("LIV-05");
    expect(r.violations).toEqual([]);
    expect(out.tick.status).toBe("committed");
    expect(out.live?.understandingRejected).toBe(1);
    expect(out.decisions).toContain("quarantine_item");
    expect(out.episodes.some((e) => e.members.includes("e2"))).toBe(true);
    expect(out.episodes.some((e) => e.members.includes("e1"))).toBe(false);
    expect(out.prepared).toHaveLength(1);
    expect(out.prepared[0]!.grounded).toEqual(["e2"]);
  });

  it("LIV-06: intent floor — 0.55 against 0.7 is prepared and shelved, never a card", async () => {
    const { r, out } = await run("LIV-06");
    expect(r.violations).toEqual([]);
    expect(out.prepared).toHaveLength(1);
    expect(out.prepared[0]).toMatchObject({ surface: "shelf", intent_confidence: 0.55 });
    expect(out.live?.prepared).toMatchObject({ persisted: 1, cards: 0, shelved: 1 });
    expect(out.decisions).toContain("prepare_shelved");
  });

  it("LIV-07: no starvation — 200 history bundles queued and every background slot held, and the live flush still lands", async () => {
    const { r, out } = await run("LIV-07");
    expect(r.violations).toEqual([]);
    expect(out.tick.status).toBe("committed");
    // Both §7.3 calls went through the reserved live lane while the
    // background lanes were parked, and neither parked call was released
    // first — the pool held the live slot back, as GATE-09 says it must.
    expect(r.metrics).toMatchObject({ canned_live_answers: 1, canned_decide_answers: 1, canned_critic_answers: 1 });
    const st = (r.output as { starvation: { inFlightBefore: number; waitingBefore: number; elapsedMs: number; historyCompletedDuringLive: number; historyBundles: number } }).starvation;
    expect(st.historyBundles).toBe(200);
    expect(st.inFlightBefore).toBeGreaterThan(0);
    expect(st.waitingBefore).toBeGreaterThan(0);
    expect(st.historyCompletedDuringLive).toBe(0);
    expect(st.elapsedMs).toBeLessThan(30_000);
    // The flush produced what a flush is for.
    expect(out.prepared).toHaveLength(1);
    expect(out.prepared[0]).toMatchObject({ kind: "needs_you", surface: "card", grounded: ["e1"] });
    expect(out.episodes.find((e) => e.id === "ep_611")!.members).toContain("e1");
  });
});
