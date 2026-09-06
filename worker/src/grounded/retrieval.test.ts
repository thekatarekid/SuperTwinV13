// ===========================================================================
// The bar's retrieval (V6 P1 S5.5): the plan route.v1 wrote, executed by
// code — lexical ∪ vector ∪ structured ∪ graph ∪ time_window → RRF →
// reranker. Zero model calls; the reranker is injected (or refused) so the
// suite never reaches for a model file.
//
// What matters here is what the fusion is ALLOWED to decide:
//   * an aggregate's value comes from the structured method, never the top-k
//     (BAR-04) — the rows ride along only as citations;
//   * a time-window scan carries its own `complete` flag, because an absence
//     answer over a truncated scan is not an absence answer (BAR-05);
//   * a stream filter really filters, so "the whole wa:goa-gang thread" means
//     that thread.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Kolkata";
const tmpRoot = mkdtempSync(join(tmpdir(), "st-bar-retrieval-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { appendEvent } = await import("../db/eventlog.js");
const { setClaimTypedFields, SELF_ENTITY_ID } = await import("../db/v6graph.js");
const { writeClaimVersion } = await import("../claims/store.js");
const { routeHeuristic } = await import("../prompts/route.v1.js");
const { executePlan, resolveStreamKeys, structuredFromPlan } = await import("./retrieval.js");
const { LEXICAL_OVERLAP_RERANKER } = await import("../retrieval/reranker.js");

/** Golden-evals clock: Sat 2026-09-05 10:00 IST. */
const NOW = new Date("2026-09-05T04:30:00.000Z");

let seq = 0;

function ev(text: string, opts: { streamKey?: string; ts?: string; actor?: string } = {}): string {
  seq += 1;
  const { id } = appendEvent({
    ts: opts.ts ?? new Date(NOW.getTime() - seq * 3_600_000).toISOString(),
    source: (opts.streamKey ?? "wa:goa-gang").split(":")[0] ?? "wa",
    kind: "wa.message",
    origin: "live",
    streamKey: opts.streamKey ?? "wa:goa-gang",
    actor: opts.actor ?? "contact:rohan",
    roles: { sender: opts.actor ?? "contact:rohan", audience: ["self"], receiver: ["self"], mentions: [] },
    payload: { text },
  });
  return id;
}

function receipt(merchant: string, amount: number | null, date: string): string {
  seq += 1;
  const key = `claim_${seq}`;
  const text = `Paid ₹${amount ?? "?"} to ${merchant}`;
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
  return key;
}

beforeAll(() => {
  runMigrations();
});

afterAll(() => {
  closeDb();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec(`DELETE FROM claims; DELETE FROM claim_versions; DELETE FROM events; DELETE FROM decisions;`);
  seq = 0;
});

// ---------------------------------------------------------------------------

describe("executePlan — lexical", () => {
  it("returns hydrated passages best-first, tagged with the method that found them", async () => {
    const hit = ev("max 6k a night yaar for the anjuna villa");
    ev("lunch tomorrow?");
    const plan = { ...routeHeuristic("villa night budget", NOW), methods: ["lexical" as const] };
    const r = await executePlan("anjuna villa night", plan, { now: NOW, reranker: null });

    expect(r.methods_ran).toEqual(["lexical"]);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]!.id).toBe(hit);
    expect(r.candidates[0]!.kind).toBe("event");
    expect(r.candidates[0]!.methods).toContain("lexical");
    expect(r.candidates[0]!.text).toContain("6k a night");
    expect(r.candidates[0]!.rerank).toBeNull();
  });

  it("a stream filter really filters — the other thread never enters the fusion", async () => {
    ev("villa advance pending", { streamKey: "wa:goa-gang" });
    ev("villa advance pending", { streamKey: "wa:family" });
    const plan = { ...routeHeuristic("villa advance", NOW), methods: ["lexical" as const], filters: { stream: "wa:goa-gang" } };
    const r = await executePlan("villa advance", plan, { now: NOW, reranker: null });
    expect(r.stream_keys).toEqual(["wa:goa-gang"]);
    expect(r.candidates.every((c) => c.stream === "wa:goa-gang")).toBe(true);
  });
});

describe("executePlan — structured (BAR-04: never from the top-k)", () => {
  it("an aggregate class runs structured whatever the plan said, and the value is exact", async () => {
    receipt("Uber", 340, "2026-08-03");
    receipt("Uber", 280, "2026-08-14");
    receipt("Uber", 400, "2026-08-27");
    receipt("Uber", 199, "2026-09-02"); // outside the asked month
    receipt("Swiggy", 560, "2026-08-12"); // wrong merchant

    const plan = routeHeuristic("how much did I spend on cabs last month", NOW);
    plan.methods = []; // the plan forgot; the class does not
    const r = await executePlan("how much did I spend on cabs last month", plan, { now: NOW, reranker: null });

    expect(r.methods_ran).toContain("structured");
    expect(r.structured).not.toBeNull();
    expect(r.structured!.op).toBe("sum");
    expect(r.structured!.value).toBe(1020);
    expect(r.structured!.rowCount).toBe(3);
    expect(r.structured!.complete).toBe(true);
  });

  it("structuredFromPlan keeps the deterministic merchant set and fills the range from the plan", () => {
    const plan = {
      ...routeHeuristic("how many rides", NOW),
      filters: { merchant_in: ["Uber", "Ola"] },
      time: { from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:00Z" },
    };
    const q = structuredFromPlan("how many rides", plan, NOW);
    expect(q).not.toBeNull();
    // "rides" already resolves to the cab merchant category in code — the
    // model's shorter list never narrows what the deterministic planner saw.
    expect(q!.filters!.merchant).toEqual(expect.arrayContaining(["uber", "ola"]));
    expect(q!.filters!.dateFrom).toBe("2026-08-01");
    expect(q!.filters!.dateTo).toBe("2026-08-31");
  });

  it("structuredFromPlan builds the query from the plan alone when the code planner sees none", () => {
    const plan = {
      ...routeHeuristic("anjuna villa", NOW),
      filters: { merchant_in: ["Airbnb"] },
      time: { from: "2026-08-01T00:00:00Z", to: "2026-08-31T23:59:00Z" },
    };
    const q = structuredFromPlan("anjuna villa", plan, NOW);
    expect(q).not.toBeNull();
    expect(q!.filters!.merchant).toEqual(["Airbnb"]);
    expect(q!.filters!.dateFrom).toBe("2026-08-01");
    expect(structuredFromPlan("anjuna villa", routeHeuristic("anjuna villa", NOW), NOW)).toBeNull();
  });

  it("no typed rows → no structured result, and the caller is told so", async () => {
    const plan = routeHeuristic("how much did I spend on cabs last month", NOW);
    const r = await executePlan("how much did I spend on cabs last month", plan, { now: NOW, reranker: null });
    expect(r.methods_ran).toContain("structured");
    expect(r.structured?.rowCount ?? 0).toBe(0);
  });
});

describe("executePlan — time window (BAR-05: a truncated scan is not a no)", () => {
  it("scans the named thread in range and reports it complete", async () => {
    for (let i = 0; i < 12; i += 1) ev(`goa gang chatter ${i}`, { streamKey: "wa:goa-gang" });
    ev("family stuff", { streamKey: "wa:family" });
    const plan = routeHeuristic("did karan ever pay the advance", NOW);
    plan.filters = { stream: "wa:goa-gang" };
    const r = await executePlan("did karan ever pay the advance", plan, { now: NOW, reranker: null });

    expect(r.methods_ran).toContain("time_window");
    expect(r.time_window).not.toBeNull();
    expect(r.time_window!.count).toBe(12);
    expect(r.time_window!.complete).toBe(true);
  });

  it("marks the scan incomplete when the cap cuts it", async () => {
    for (let i = 0; i < 6; i += 1) ev(`goa gang chatter ${i}`, { streamKey: "wa:goa-gang" });
    const plan = routeHeuristic("what happened tuesday afternoon", NOW);
    plan.time = { from: new Date(NOW.getTime() - 86_400_000).toISOString(), to: NOW.toISOString() };
    const r = await executePlan("what happened", plan, { now: NOW, reranker: null, window: 3 });
    // The window cap is on the FUSION, not the scan: the scan itself is whole.
    expect(r.time_window!.complete).toBe(true);
    expect(r.candidates.length).toBeLessThanOrEqual(3);
  });
});

describe("executePlan — fusion and reranking", () => {
  it("a row two methods found outranks a row only one found", async () => {
    const both = ev("anjuna villa advance 6k a night", { streamKey: "wa:goa-gang" });
    for (let i = 0; i < 4; i += 1) ev(`unrelated ${i}`, { streamKey: "wa:goa-gang" });
    const plan = routeHeuristic("anjuna villa advance", NOW);
    plan.methods = ["lexical"];
    plan.time = { from: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(), to: NOW.toISOString() };
    plan.filters = { stream: "wa:goa-gang" };
    const r = await executePlan("anjuna villa advance", { ...plan, methods: ["lexical", "time_window"] }, { now: NOW, reranker: null });
    expect(r.candidates[0]!.id).toBe(both);
    expect(r.candidates[0]!.methods.length).toBeGreaterThan(1);
  });

  it("the injected reranker rescores the window and names itself", async () => {
    ev("lunch tomorrow", { streamKey: "wa:goa-gang" });
    ev("anjuna villa pool", { streamKey: "wa:goa-gang" });
    const plan = { ...routeHeuristic("anjuna villa pool", NOW), methods: ["lexical" as const] };
    const r = await executePlan("anjuna villa pool", plan, { now: NOW, reranker: LEXICAL_OVERLAP_RERANKER });
    expect(r.reranker).toBe(LEXICAL_OVERLAP_RERANKER.model);
    expect(r.candidates[0]!.rerank).not.toBeNull();
    expect(r.candidates[0]!.text).toContain("anjuna villa pool");
  });

  it("never writes", async () => {
    ev("anjuna villa pool");
    const before = getDb().prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number };
    await executePlan("anjuna villa", { ...routeHeuristic("anjuna villa", NOW), methods: ["lexical"] }, { now: NOW, reranker: null });
    const after = getDb().prepare(`SELECT COUNT(*) AS n FROM decisions`).get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});

describe("resolveStreamKeys", () => {
  it("takes an exact key, and falls back to a label match", () => {
    ev("hello", { streamKey: "wa:goa-gang" });
    expect(resolveStreamKeys("wa:goa-gang")).toEqual(["wa:goa-gang"]);
    expect(resolveStreamKeys("goa gang")).toEqual(["wa:goa-gang"]);
    expect(resolveStreamKeys(undefined)).toEqual([]);
    expect(resolveStreamKeys("nothing like this exists")).toEqual([]);
  });
});
