// ===========================================================================
// TIER + DIG executors (V6 P1 S3.8): the six fixtures in evals/v13 through the
// real tiering / promotion / digest planner / digest.v2 pass — zero live
// calls. TIER-03 and DIG-02 (mode live) run against a STUBBED claude-local
// provider registered for the test; the code cases never reach a provider at
// all (TIER-01/02/04), or run against the canned provider-layer stub (DIG-01).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { registerV2 } from "../../providers/registry.js";
import { providerRequestText, providerV2TestDouble } from "../../providers/test-support.js";
import type { ProviderV2, Usage } from "../../providers/types.js";
import { loadFixture } from "../fixtures.js";
import { registeredPasses } from "../runner.js";
import { digExecutor, isDigFixture, runDigCase } from "./dig.js";
import { registerProductExecutors } from "./index.js";
import { runTierCase, tierExecutor } from "./tier.js";

const FIX = join(import.meta.dirname, "../../../../evals/v13");

let tmpDir: string;
let calls: string[] = [];
let answers: string[] = [];

/** Registered as `claude-local` — the default provider the executors resolve when no deps are passed. */
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
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-tier-dig-eval-"));
  process.env.SUPERTWIN_HOME = tmpDir;
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  calls = [];
  answers = [];
  registerV2(stubProvider());
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_HOME;
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

const fixture = (id: string) => loadFixture(join(FIX, `${id}.json`));

function rowCount(table: string, where = "1=1"): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

describe("registration", () => {
  it("`tier` is registered; `digest` routes DIG-* to the V6 executor and everything else to the legacy CAT path", async () => {
    await registerProductExecutors();
    expect(registeredPasses()).toContain("tier");
    expect(registeredPasses()).toContain("digest");
    expect(isDigFixture(fixture("DIG-01"))).toBe(true);
    expect(isDigFixture(fixture("TIER-01"))).toBe(false);
  });
});

describe("TIER executor", () => {
  for (const id of ["TIER-01", "TIER-02", "TIER-04"]) {
    it(`${id} (code) passes with no violations and zero model calls`, async () => {
      const f = fixture(id);
      expect(f.mode).toBe("code");
      expect(f.pass).toBe("tier");
      const r = await tierExecutor({ fixture: f });
      expect(r.violations ?? []).toEqual([]);
      expect(r.ok).toBe(true);
      expect(r.metrics?.model_calls).toBe(0);
      expect(calls).toHaveLength(0);
      // the harness DB is left clean
      expect(rowCount("events")).toBe(0);
      expect(rowCount("streams")).toBe(0);
      expect(rowCount("decisions", "target_kind = 'stream'")).toBe(0);
    });
  }

  it("TIER-04 reports the promotion: T3 → T1, 12 re-queued, decision logged", async () => {
    const r = await runTierCase(fixture("TIER-04"));
    const out = r.output as { before: { tier: string; stamped: number }; after: { tier: string; requeued: number; historyEvents: number; inDigest: boolean; decision: { old: unknown; new: { requeued: number } } } };
    expect(out.before).toMatchObject({ tier: "T3", stamped: 12 });
    expect(out.after).toMatchObject({ tier: "T1", requeued: 12, historyEvents: 12, inDigest: false });
    expect(out.after.decision.old).toEqual({ tier: "T3" });
    expect(out.after.decision.new.requeued).toBe(12);
    expect(r.metrics?.requeued).toBe(12);
  });

  it("TIER-03 (live, stubbed) makes exactly ONE tier.v1 call and serves the second pass from the cache", async () => {
    answers = [JSON.stringify({ tier: 2, reason: "active account: OTPs, statements and EMIs", confidence: 0.94 })];
    const f = fixture("TIER-03");
    expect(f.mode).toBe("live");
    const r = await tierExecutor({ fixture: f });
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("BUSINESS SENDER HDFC Bank");
    expect(calls[0]).toContain("<untrusted>");
    expect(r.metrics).toMatchObject({ model_calls: 1, tier_accuracy: 1, cache_hits: 1 });
    const out = r.output as { first: { tier: string; source: string }; second: { tier: string; cached: boolean; modelCalls: number } };
    expect(out.first).toMatchObject({ tier: "T2", source: "tier.v1" });
    expect(out.second).toMatchObject({ tier: "T2", cached: true, modelCalls: 0 });
    // the one call is in the ledger under its version; the case rows are gone
    expect(rowCount("runs", "pass = 'tier.v1'")).toBe(1);
    expect(rowCount("streams")).toBe(0);
  });

  it("TIER-03 names the wrong modes: a re-ask on the second pass is `cache-miss`, tier 1 is `business-tier1`", async () => {
    // A stub that answers tier 3 with a reason — cached, so still exactly one call; the tier is not T2 → ok=false, no wrong label.
    answers = [JSON.stringify({ tier: 3, reason: "past relationship", confidence: 0.6 })];
    const r = await runTierCase(fixture("TIER-03"));
    expect(r.ok).toBe(false);
    expect(r.violations ?? []).toEqual([]);
    expect(calls).toHaveLength(1);
    // Unusable answers are never cached → a second pass re-asks → `cache-miss`.
    calls = [];
    answers = ["no idea", "still no idea"];
    const again = await runTierCase(fixture("TIER-03"));
    expect(again.violations?.map((v) => v.label)).toEqual(["cache-miss"]);
    expect(calls).toHaveLength(2);
  });
});

const DIG02_ANSWER = JSON.stringify({
  summary: "Society notices: water tank cleaning Thursday, lift B down till Saturday, maintenance due by the 5th.\nParking sticker renewal opens Monday; nothing needed a reply.",
  claims: [
    {
      subject: "Sunrise Apartments 402",
      kind: "fact",
      text: "Society maintenance is paid by UPI to society@okaxis or at the office",
      provenance: "observed",
      fields: { merchant: "society" },
      evidence: [{ event_ids: ["e3"], quote: "Pay by UPI to society@okaxis or at the office" }],
      confidence: 0.8,
    },
  ],
  recurrences: [
    { text: "Society maintenance due monthly by the 5th", rule: "monthly on the 5th", evidence: [{ event_ids: ["e3"], quote: "maintenance for Sept due by 5th" }], confidence: 0.7 },
  ],
  // the model tried to surface the volunteers line as an active task — stripped, named
  tasks: [{ title: "Volunteer for Ganpati decoration", status: "open", due: "2026-09-06" }],
});

describe("DIG executor", () => {
  it("DIG-01 (code) plans and makes exactly 2 digest calls for 3 weeks with week 2 empty, none on rerun, 1 once the current week ends", async () => {
    const f = fixture("DIG-01");
    expect(f.mode).toBe("code");
    expect(f.pass).toBe("digest");
    const r = await digExecutor({ fixture: f });
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    // the canned provider-layer stub answered — the registered claude-local stub was never touched
    expect(calls).toHaveLength(0);
    const out = r.output as { planned: { week: string; events: number }[]; calls: { week: string; status: string }[]; rerun_calls: number; next_week_calls: { week: string }[] };
    expect(out.planned).toEqual([
      { week: "2026-08-17", events: 3 },
      { week: "2026-08-03", events: 2 },
    ]);
    expect(out.calls.map((c) => [c.week, c.status])).toEqual([["2026-08-17", "ok"], ["2026-08-03", "ok"]]);
    expect(out.rerun_calls).toBe(0);
    expect(out.next_week_calls).toEqual([{ week: "2026-08-24", events: 1 }]);
    expect(r.metrics).toMatchObject({ digest_calls: 2, empty_week_call: 0 });
    expect(rowCount("events")).toBe(0);
    expect(rowCount("decisions", "pass = 'digest'")).toBe(0);
  });

  it("DIG-02 (live, stubbed) asserts the shape by code: summary/claims/recurrences only, inflation stripped and named, nothing active", async () => {
    answers = [DIG02_ANSWER];
    const f = fixture("DIG-02");
    expect(f.mode).toBe("live");
    const r = await digExecutor({ fixture: f });
    expect(r.violations ?? []).toEqual([]);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("week of 2026-08-24");
    expect(calls[0]).toContain("<untrusted>");
    const out = r.output as { digest: { summary: string; claims: unknown[]; recurrences: unknown[] }; stripped: string[]; decisions: string[]; tables: Record<string, number> };
    expect(Object.keys(out.digest).sort()).toEqual(["claims", "recurrences", "summary"]);
    expect(out.digest.claims).toHaveLength(1);
    expect(out.digest.recurrences).toHaveLength(1);
    expect(out.stripped).toEqual(["digest-inflation:tasks"]);
    expect(out.decisions.sort()).toEqual(["digest_summary", "propose", "propose_recurrence"]);
    expect(out.tables).toEqual({ tasks: 0, spaces: 0, episodes: 0 });
    expect(r.metrics).toMatchObject({ model_calls: 1, digest_inflation: 1, claims: 1, recurrences: 1, empty_week_call: 0 });
    expect(r.gateObservations?.find((g) => g.gateId === "digest_inflation")?.passed).toBe(false); // tracked, printed, named
    expect(r.seededContext).toContain("e3 2026-08-27T08:30:00Z contact:secretary:");
  });

  it("DIG-02 fails closed on an unparseable answer", async () => {
    answers = ["I cannot summarize this"];
    const r = await runDigCase(fixture("DIG-02"));
    expect(r.ok).toBe(false);
    const out = r.output as { status: string; digest: unknown };
    expect(out.status).toBe("failed");
    expect(out.digest).toBeNull();
  });
});
