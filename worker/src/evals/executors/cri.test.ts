// ===========================================================================
// CRI executor (V6 P1 S3.5): the four structured fixtures in evals/v13 through
// the mechanical layer + a STUBBED critic.v5 provider — zero live calls.
// CRI-04 (code) never reaches a provider at all.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, runMigrations } from "../../db/connection.js";
import { registerV2 } from "../../providers/registry.js";
import { providerRequestText, providerV2TestDouble } from "../../providers/test-support.js";
import type { ProviderV2, Usage } from "../../providers/types.js";
import { resetStableSystemPromptsForTests } from "../../brain/llm.js";
import { loadFixture } from "../fixtures.js";
import { assessCri, criExecutor, isStructuredCriFixture, parseCriCase, renderCriPack, renderCriUser, runCriCase } from "./cri.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;
let calls: string[] = [];
let answers: string[] = [];

function stubProvider(): ProviderV2 {
  return providerV2TestDouble(async (opts) => {
      calls.push(providerRequestText(opts));
      const text = answers.shift() ?? "{}";
      opts.onEvent({ type: "delta", text });
      const usage: Usage = { inputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 5 };
      opts.onEvent({ type: "done", continuation: null, usage });
      return { continuation: null, usage, freshFallback: false, status: "ok" as const };
  });
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-cri-eval-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  resetStableSystemPromptsForTests();
  calls = [];
  answers = [];
  registerV2(stubProvider());
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const load = (id: string) => loadFixture(join(FIX, `${id}.json`));

describe("fixture shape and rendering", () => {
  it("the four §5.9 fixtures are structured critic cases; CRI-04 is code", () => {
    for (const id of ["CRI-01", "CRI-02", "CRI-03", "CRI-04"]) {
      const f = load(id);
      expect(f.pass).toBe("critic");
      expect(isStructuredCriFixture(f)).toBe(true);
      expect(f.mode).toBe(id === "CRI-04" ? "code" : "live");
    }
  });

  it("renders the V6 pack: blocks, ONE untrusted block, sectioned streams, event heads", () => {
    const c = parseCriCase(load("CRI-04"));
    const pack = renderCriPack(c);
    for (const b of ["[NOW]", "[ROSTER]", "[OPEN TASKS]", "[CALENDAR]", "[CANDIDATE SPACES]", "[BRIDGED]", "[EPISODES]", "[BUNDLE] 2 events · 2 streams"]) {
      expect(pack).toContain(b);
    }
    expect(pack.match(/<untrusted>/g)).toHaveLength(1);
    expect(pack.match(/<\/untrusted>/g)).toHaveLength(1);
    expect(pack).toContain("[STREAM S1: wa:goa-gang@g.us]");
    expect(pack).toContain("[STREAM S2: browser:chrome:default:airbnb.co.in:2026-09-05]");
    expect(pack).toContain(" e2 09:57 browser [Chrome · Villa Sol · Anjuna · airbnb.co.in/rooms/5521] self: Villa Sol");
    expect(pack).toContain('sp_goa_dec "Goa trip with Rohan in December"');
    // The blocks come before the untrusted block; every captured line is inside it.
    expect(pack.indexOf("[CANDIDATE SPACES]")).toBeLessThan(pack.indexOf("<untrusted>"));
    expect(pack.indexOf(" e1 ")).toBeGreaterThan(pack.indexOf("<untrusted>"));
  });

  it("numbers the write set as the P-03 user block does, with an [EDGES] restatement and the mechanical block", async () => {
    const run = await runCriCase(load("CRI-04"));
    expect(run.user).toContain('1 EPISODE new S1 e1 "Rohan shares the Villa Sol Airbnb listing." → sp_goa_dec quote:"villa sol dekho airbnb.co.in/rooms/5521" conf 0.9');
    expect(run.user).toContain("3 EDGE bridge:url e1→e2 conf 0.6");
    expect(run.user).toContain("  3. [edge] bridge:url e1 → e2 · conf 0.6");
    expect(run.user).toContain("bridge edges below 1.0 (rejected by code): items 3");
    expect(run.user).toContain("uncovered aliases: (none");
  });
});

describe("CRI-04 (code) — bridge edge at 0.6 rejects with zero model calls", () => {
  it("passes on the mechanical layer alone", async () => {
    const r = await criExecutor({ fixture: load("CRI-04") });
    expect(calls).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.violations ?? []).toEqual([]);
    expect(r.metrics?.model_calls).toBe(0);
    const out = r.output as { verdicts: Array<{ item: number; verdict: string; reason?: string }>; uncovered: string[] };
    expect(out.verdicts).toEqual([{ item: 3, verdict: "reject", reason: "bridge:url edge at 0.6 — bridges are exact: 1.0 or nothing" }]);
    expect(out.uncovered).toEqual([]);
  });

  it("an accepted edge is the edge-accepted wrong[] mode", () => {
    const f = load("CRI-04");
    const a = assessCri(f, { verdicts: [{ item: 3, verdict: "commit" }] }, { uncovered: [], duplicated: [], notVerbatim: [], multiStream: [], edgeVerdicts: [], items: 3 });
    expect(a.ok).toBe(false);
    expect(a.violations.map((v) => v.label)).toEqual(["edge-accepted"]);
    const cov = assessCri(f, { verdicts: [{ item: 3, verdict: "reject", reason: "r" }] }, { uncovered: ["e2"], duplicated: [], notVerbatim: [], multiStream: [], edgeVerdicts: [], items: 3 });
    expect(cov.violations.map((v) => v.label)).toEqual(["coverage-miss"]);
  });
});

describe("live cases against a stubbed critic.v5", () => {
  it("CRI-01: a reject naming sp_goa_dec passes; a flag_overlap is flag-not-reject; a commit is rubber-stamp", async () => {
    const f = load("CRI-01");
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "reject", reason: "near-duplicate of sp_goa_dec in view", space_id: "sp_goa_dec" }], uncovered: [] })];
    const ok = await criExecutor({ fixture: f });
    expect(ok.ok).toBe(true);
    expect(ok.violations).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("[PACK]");
    expect(calls[0]).toContain('1 PROPOSAL new space "Goa December trip" S1 e1');
    expect(ok.metrics?.verdict_accuracy).toBe(1);

    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "flag_overlap", space_id: "sp_goa_dec" }] })];
    const flagged = await criExecutor({ fixture: f });
    expect(flagged.ok).toBe(false);
    expect(flagged.violations?.map((v) => v.label)).toEqual(["flag-not-reject"]);

    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] })];
    const stamped = await criExecutor({ fixture: f });
    expect(stamped.violations?.map((v) => v.label)).toEqual(["rubber-stamp"]);

    // A reject that names the wrong space fails without a wrong[] label (a note).
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "reject", reason: "duplicate" }] })];
    const unnamed = await criExecutor({ fixture: f });
    expect(unnamed.ok).toBe(false);
    expect(unnamed.violations).toEqual([]);
    expect(unnamed.notes?.[0]).toMatch(/does not name sp_goa_dec/);
  });

  it("CRI-02: flag_overlap sp_family passes; reject is reject-on-doubt; plain commit is silent-commit", async () => {
    const f = load("CRI-02");
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "flag_overlap", space_id: "sp_family" }], uncovered: [] })];
    expect((await criExecutor({ fixture: f })).ok).toBe(true);
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "reject", reason: "ambiguous" }] })];
    expect((await criExecutor({ fixture: f })).violations?.map((v) => v.label)).toEqual(["reject-on-doubt"]);
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] })];
    expect((await criExecutor({ fixture: f })).violations?.map((v) => v.label)).toEqual(["silent-commit"]);
  });

  it("CRI-03: downgrade passes; commit is rubber-stamp; reject is reject-not-downgrade; the quote is verbatim so code does not flag it", async () => {
    const f = load("CRI-03");
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "downgrade_to_unsorted", reason: "summary claims a booking; quote only says thinking" }] })];
    const r = await criExecutor({ fixture: f });
    expect(r.ok).toBe(true);
    expect((r.output as { mechanical: { notVerbatim: number[] } }).mechanical.notVerbatim).toEqual([]);
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "commit" }] })];
    expect((await criExecutor({ fixture: f })).violations?.map((v) => v.label)).toEqual(["rubber-stamp"]);
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "reject", reason: "fabricated" }] })];
    expect((await criExecutor({ fixture: f })).violations?.map((v) => v.label)).toEqual(["reject-not-downgrade"]);
  });

  it("the user block is the same rendering runCriCase produced (judge and pass see one world)", async () => {
    const f = load("CRI-02");
    answers = [JSON.stringify({ verdicts: [{ item: 1, verdict: "flag_overlap", space_id: "sp_family" }] })];
    const r = await criExecutor({ fixture: f });
    const c = parseCriCase(f);
    expect(r.seededContext).toBe(renderCriUser(c, (r.output as { mechanical: never }).mechanical));
    expect(r.seededContext).toContain("[STREAM S1: wa:rohan]");
  });
});
