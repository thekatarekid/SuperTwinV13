// ===========================================================================
// EXE executor (V6 P1 S4.2): the five code cases run against the real
// fixtures in evals/v13 through the real executor/lite.ts — scripted
// provider, scripted web, pinned clock, zero model calls, sandboxed DB.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetStableSystemPromptsForTests } from "../../brain/llm.js";
import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { setConsentGateMode } from "../../db/consent-gate.js";
import { loadFixture } from "../fixtures.js";
import { liteExecutor } from "./exe.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-exe-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  process.env.SUPERTWIN_HOME = join(tmpDir, "home");
  closeDb();
  runMigrations();
  setConsentGateMode("open");
  resetStableSystemPromptsForTests();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

interface Out {
  status: string;
  turns: { used: number; attempted: number; ceiling: number };
  money: { usd: number; ceiling: number };
  refusals: { tool: string; reason: string; detail: string }[];
  fetches: { url: string; outcome: string; attempts: number }[];
  invocations: { tool: string; status: string; detail?: string }[];
  questions: { field: string; prefill: string | null; confirm: boolean }[];
  artifact: { type: string; title: string; citations: { url: string | null; event_ids: string[] }[] } | null;
  dropped_citations: number;
  gaps: string[];
  artifacts: { kind: string; title: string }[];
  question_cards: string[];
  trace_ceilings: Record<string, number>;
}

async function run(id: string) {
  const fixture = loadFixture(join(FIX, `${id}.json`));
  expect(fixture.mode).toBe("code");
  expect(fixture.pass).toBe("lite");
  const r = await liteExecutor({ fixture });
  expect(r.metrics!.model_calls).toBe(0);
  // canned answers never reach the ledger, and the case cleaned up after itself
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM deferred_outputs`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM artifacts`).get() as { n: number }).n).toBe(0);
  expect((getDb().prepare(`SELECT COUNT(*) AS n FROM spaces`).get() as { n: number }).n).toBe(0);
  return { r, out: r.output as Out };
}

describe("executor-lite executor (EXE-01..05)", () => {
  it("EXE-01: 12 turns asked, 4-turn ceiling — 3 executed, 9 refused, both ceilings in the trace", async () => {
    const { r, out } = await run("EXE-01");
    expect(r.violations).toEqual([]);
    expect(r.ok).toBe(true);
    expect(out.turns.ceiling).toBe(4);
    expect(out.turns.used).toBeLessThanOrEqual(4);
    expect(out.invocations.filter((i) => i.status === "ok")).toHaveLength(3);
    expect(out.refusals.filter((x) => x.reason === "cycle_ceiling")).toHaveLength(9);
    expect(out.trace_ceilings).toEqual({ max_turns: 4, cost_usd: 0.05, doc_max_turns: 8 });
    expect(r.metrics).toMatchObject({ unbounded_loop: 0, turn_ceiling: 4 });
    expect(r.gateObservations).toContainEqual({ gateId: "unbounded_loop", passed: true, counted: true });
  });

  it("EXE-02: dates missing, budget doubted — one card 'dates? budget?', no fetch, no call", async () => {
    const { r, out } = await run("EXE-02");
    expect(r.violations).toEqual([]);
    expect(out.status).toBe("question");
    expect(out.fetches).toHaveLength(0);
    expect(r.metrics!.canned_model_answers).toBe(0);
    expect(out.question_cards).toEqual(["dates? budget?"]);
    expect(out.questions).toEqual([
      { field: "dates", prefill: null, confirm: false, why: expect.any(String) },
      { field: "budget", prefill: "6000/night", confirm: true, why: expect.any(String) },
    ]);
    expect(out.artifacts.map((a) => a.kind)).toEqual(["question"]);
  });

  it("EXE-03: the table cites the pages it fetched and the events that set budget and dates", async () => {
    const { r, out } = await run("EXE-03");
    expect(r.violations).toEqual([]);
    expect(out.status).toBe("done");
    expect(out.artifact?.type).toBe("comparison");
    expect(out.artifact?.citations.map((c) => c.url)).toEqual([
      "https://villas.example/sol",
      "https://villas.example/casa",
    ]);
    expect(out.artifact?.citations.flatMap((c) => c.event_ids).sort()).toEqual(["ev_budget", "ev_dates"]);
    expect(out.dropped_citations).toBe(1); // the page it never opened
    expect(out.artifacts.map((a) => a.kind)).toEqual(["comparison"]);
  });

  it("EXE-04: 429 retried exactly once, 404 replanned without a retry", async () => {
    const { r, out } = await run("EXE-04");
    expect(r.violations).toEqual([]);
    expect(out.fetches).toEqual([
      { url: "https://villas.example/sol", outcome: "retried_ok", attempts: 2, status: 200, bytes: expect.any(Number) },
      { url: "https://villas.example/gone", outcome: "permanent", attempts: 1, status: 404, bytes: 0, detail: "HTTP 404" },
    ]);
    expect(out.status).toBe("partial");
  });

  it("EXE-05: a login wall stops the run, refuses the next fetch and asks", async () => {
    const { r, out } = await run("EXE-05");
    expect(r.violations).toEqual([]);
    expect(out.status).toBe("blocked");
    expect(out.fetches.filter((f) => f.outcome === "login_wall")).toHaveLength(1);
    expect(out.fetches.filter((f) => f.outcome === "ok" || f.outcome === "retried_ok")).toHaveLength(0);
    expect(out.refusals.map((x) => x.reason)).toContain("login_wall");
    expect(out.question_cards).toHaveLength(1);
    expect(r.metrics!.login_automation).toBe(0);
    expect(r.gateObservations).toContainEqual({ gateId: "login_automation", passed: true, counted: true });
  });
});
