// ===========================================================================
// [CODE + one cached call] TIER — the tiering executor (GoldenEvals V6 P1
// §5.18; V6 P1 S3.8). Against the REAL tiers/tiering.ts + tiers/promote.ts
// over the real single writer (db/eventlog.ts appendEvents):
//
//   TIER-01  a replied-in group is tier 1                       code, 0 calls
//   TIER-02  a never-replied 180-member group is tier 3        code, 0 calls
//   TIER-03  HDFC with OTPs and bills is tier 2                live: exactly
//            ONE tier.v1 call; the second pass is served from the cache
//   TIER-04  a reply promotes instantly and retroactively:     code, 0 calls
//            a tier-3 group becomes tier 1 and its history is re-queued
//
// `model_calls` is measured on every case from the run ledger (runs rows with
// pass tier.v1 written during the case) — the code cases must read 0.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { appendEvents } from "../../db/eventlog.js";
import { planDigest } from "../../scheduler/v6/digest.js";
import { planHistory } from "../../scheduler/v6/history.js";
import { append, MIN, msgAt, streamIdOf } from "../../scheduler/v6/testutil.js";
import { readTier } from "../../tiers/derive.js";
import { pendingRequeueCount } from "../../tiers/promote.js";
import { tierStream, type TieringDeps, type TierStreamReport } from "../../tiers/tiering.js";
import type { Fixture } from "../fixtures.js";
import type { Executor, ExecutorResult, Violation } from "../runner.js";
import { CaseWorld } from "./bnd.js";

const DAY = 86_400_000;
/** A Friday noon; the fixtures' "now". */
const T0 = Date.parse("2026-08-28T12:00:00.000Z");

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : dflt;
}
function strs(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The HDFC sample the doc names: OTPs and bills. */
export const HDFC_SAMPLE: readonly string[] = [
  "Your OTP for HDFC Bank NetBanking is 482913. Valid for 10 minutes. Do not share it with anyone.",
  "HDFC Bank: Rs.24,110.00 debited from a/c **4321 on 05-Aug-26 towards Credit Card bill payment. Avl bal Rs.1,02,330.15",
  "Your HDFC Bank Credit Card statement for Aug-26 is ready. Total amount due Rs.31,204.00, minimum due Rs.1,560.00, pay by 03-Sep-26.",
  "Alert: Rs.2,499.00 spent on HDFC Bank Card **4321 at AMAZON PAY on 12-Aug-26. Not you? Call 18002586161.",
  "Your OTP is 118273 for a transaction of Rs.1,200.00 at SWIGGY. Valid for 5 mins.",
  "HDFC Bank: EMI of Rs.8,400.00 for loan a/c **7781 is due on 15-Aug-26. Please maintain sufficient balance.",
  "Dear Customer, your HDFC Bank FD of Rs.2,00,000 matures on 30-Sep-26. Renewal instructions: auto-renew.",
  "HDFC Bank: Rs.560.00 debited via UPI to ZOMATO on 27-Aug-26. UPI Ref 523412345678.",
];

function tierRuns(sinceRowid: number): number {
  const r = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM runs WHERE pass = 'tier.v1' AND rowid > ?`)
    .get(sinceRowid) as { n: number };
  return r.n;
}
function runsHighWater(): number {
  const r = getDb().prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM runs`).get() as { m: number };
  return r.m;
}
function markBusiness(streamId: string, label: string): void {
  getDb().prepare(`UPDATE streams SET is_business = 1, label = ?, stream_kind = 'business' WHERE id = ?`).run(label, streamId);
}
function stampAll(streamId: string, whenMs: number): void {
  getDb().prepare(`UPDATE events SET dispatched_at = ? WHERE stream_id = ?`).run(new Date(whenMs).toISOString(), streamId);
}

type CaseFn = (fixture: Fixture, w: CaseWorld, deps: TieringDeps) => Promise<ExecutorResult> | ExecutorResult;

const tier01: CaseFn = async (_fixture, w, deps) => {
  const key = w.key("goa-gang@g.us");
  append(
    [
      msgAt(key, T0 - 3 * DAY, "goa december mein chalte hai na, dates lock karo", { actor: "contact:rohan", origin: "backfill" }),
      msgAt(key, T0 - 3 * DAY + 20 * MIN, "haan chalo, 18-21 dec lock karte hai", { actor: "self", origin: "backfill" }),
      msgAt(key, T0 - 2 * DAY, "villa shortlist bhejta hu", { actor: "contact:tanvi", origin: "backfill" }),
    ],
    T0,
  );
  const sid = streamIdOf("wa", key);
  const mark = runsHighWater();
  const r = await tierStream(sid, deps);
  const calls = tierRuns(mark);
  const violations: Violation[] = [];
  if (r.change.to !== "T1") violations.push({ label: "replied-not-tier1", note: `got ${r.change.to} (${r.decision.rule})` });
  if (calls > 0 || r.modelCalls > 0) violations.push({ label: "model-asked-about-reply", note: `${calls} tier.v1 run(s)` });
  return {
    ok: violations.length === 0 && readTier(sid) === "T1" && r.decision.rule === "engaged",
    output: { tier: r.change.to, rule: r.decision.rule, source: r.decision.source, stored: readTier(sid) },
    violations,
    metrics: { model_calls: calls, tier_accuracy: r.change.to === "T1" ? 1 : 0 },
    gateObservations: [{ gateId: "tier_accuracy", passed: r.change.to === "T1", counted: true }],
  };
};

const tier02: CaseFn = async (fixture, w, deps) => {
  const members = num(rec(fixture.setup).members, 180);
  const key = w.key("mumbai-founders@g.us");
  const envs = [];
  for (let i = 0; i < members; i++) {
    envs.push(msgAt(key, T0 - 30 * DAY + i * 10 * MIN, `member ${i}: anyone hiring a growth lead? DM me`, { actor: `contact:m${i}`, origin: "backfill" }));
  }
  append(envs, T0);
  const sid = streamIdOf("wa", key);
  const mark = runsHighWater();
  const r = await tierStream(sid, deps);
  const calls = tierRuns(mark);
  const violations: Violation[] = [];
  if (r.change.to === "T1") violations.push({ label: "lurker-tier1", note: `rule ${r.decision.rule}` });
  if (calls > 0 || r.modelCalls > 0) violations.push({ label: "model-asked-about-group", note: `${calls} tier.v1 run(s)` });
  const inHistory = planHistory({ streamKeyPrefix: w.prefix }).some((b) => b.streamId === sid);
  const inDigest = planDigest({ nowMs: T0, streamKeyPrefix: w.prefix }).some((b) => b.streamId === sid);
  return {
    ok: violations.length === 0 && r.change.to === "T3" && r.decision.rule === "group_never_replied" && !inHistory && inDigest,
    output: { tier: r.change.to, rule: r.decision.rule, distinctSenders: members, lanes: { history: inHistory, digest: inDigest } },
    violations,
    metrics: { model_calls: calls, tier_accuracy: r.change.to === "T3" ? 1 : 0 },
    gateObservations: [{ gateId: "tier_accuracy", passed: r.change.to === "T3", counted: true }],
  };
};

export interface Tier03Run {
  first: TierStreamReport;
  second: TierStreamReport;
  callsFirst: number;
  callsSecond: number;
}

/** The two passes TIER-03 measures: one call, then the cache. */
export async function runTier03(w: CaseWorld, deps: TieringDeps, sample: readonly string[] = HDFC_SAMPLE): Promise<Tier03Run> {
  const key = w.key("hdfcbank@s.whatsapp.net");
  append(
    sample.map((t, i) => msgAt(key, T0 - (20 - i) * DAY, t, { actor: "contact:hdfc", origin: "backfill" })),
    T0,
  );
  const sid = streamIdOf("wa", key);
  markBusiness(sid, "HDFC Bank");
  const mark1 = runsHighWater();
  const first = await tierStream(sid, deps);
  const callsFirst = tierRuns(mark1);
  const mark2 = runsHighWater();
  const second = await tierStream(sid, deps);
  const callsSecond = tierRuns(mark2);
  return { first, second, callsFirst, callsSecond };
}

const tier03: CaseFn = async (fixture, w, deps) => {
  const sample = strs(rec(fixture.setup).sample);
  const run = await runTier03(w, deps, sample.length > 0 ? sample : HDFC_SAMPLE);
  const violations: Violation[] = [];
  if (run.callsFirst > 1) violations.push({ label: "reask-per-message", note: `${run.callsFirst} calls on the first pass` });
  if (run.callsSecond > 0) violations.push({ label: "cache-miss", note: `${run.callsSecond} call(s) on an unchanged channel` });
  if (run.first.change.to === "T1") violations.push({ label: "business-tier1", note: `rule ${run.first.decision.rule}` });
  const ok = violations.length === 0 && run.first.change.to === "T2" && run.callsFirst === 1 && run.second.cached && run.second.change.to === "T2";
  return {
    ok,
    output: {
      first: { tier: run.first.change.to, source: run.first.decision.source, reason: run.first.decision.reason, confidence: run.first.decision.confidence, modelCalls: run.first.modelCalls },
      second: { tier: run.second.change.to, cached: run.second.cached, modelCalls: run.second.modelCalls },
      defaulted: run.first.defaulted,
    },
    violations,
    metrics: { model_calls: run.callsFirst + run.callsSecond, tier_accuracy: run.first.change.to === "T2" ? 1 : 0, cache_hits: run.second.cached ? 1 : 0 },
    gateObservations: [{ gateId: "tier_accuracy", passed: run.first.change.to === "T2", counted: true }],
    notes: run.first.defaulted ? ["tier.v1 gave nothing usable — defaulted to T2 without caching"] : [],
  };
};

const tier04: CaseFn = async (fixture, w, _deps) => {
  const history = num(rec(fixture.setup).history_messages, 12);
  const key = w.key("sunrise-402@g.us");
  const envs = [];
  for (let i = 0; i < history; i++) {
    envs.push(msgAt(key, T0 - (40 - 2 * i) * DAY, `society notice ${i}: maintenance for the month due by the 5th`, { actor: "contact:secretary", origin: "backfill" }));
  }
  append(envs, T0);
  const sid = streamIdOf("wa", key);
  // A tier-3 group whose history was only ever digested.
  getDb().prepare(`UPDATE streams SET tier = 'T3', tier_rule = 'group_never_replied', tier_source = 'code' WHERE id = ?`).run(sid);
  stampAll(sid, T0 - DAY);
  const before = { tier: readTier(sid), stamped: pendingRequeueCount(sid), historyDays: planHistory({ streamKeyPrefix: w.prefix }).filter((b) => b.streamId === sid).length };

  const mark = runsHighWater();
  // The reply, through the single writer — promotion rides the same call.
  appendEvents([msgAt(key, T0, "is the plumber contact still valid? kitchen sink is leaking", { actor: "self" })], T0);
  const calls = tierRuns(mark);

  const after = {
    tier: readTier(sid),
    stamped: pendingRequeueCount(sid),
    requeued: (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND dispatched_at IS NULL AND origin = 'backfill'`).get(sid) as { n: number }).n,
    historyEvents: planHistory({ streamKeyPrefix: w.prefix }).filter((b) => b.streamId === sid).reduce((s, b) => s + b.events.length, 0),
    inDigest: planDigest({ nowMs: T0, includeCurrentWeek: true, streamKeyPrefix: w.prefix }).some((b) => b.streamId === sid),
    total: (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id = ?`).get(sid) as { n: number }).n,
    decision: getDb().prepare(`SELECT old_json, new_json FROM decisions WHERE target_id = ? AND pass = 'code:tier-promotion'`).get(sid) as { old_json: string; new_json: string } | undefined,
  };
  const violations: Violation[] = [];
  if (after.tier !== "T1") violations.push({ label: "caste-system", note: `tier still ${after.tier} after the user replied` });
  if (after.requeued !== history || after.historyEvents !== history) violations.push({ label: "history-not-requeued", note: `${after.requeued} of ${history} rows re-queued, ${after.historyEvents} in the history plan` });
  if (after.total !== history + 1) violations.push({ label: "data-deleted", note: `${after.total} rows, expected ${history + 1}` });
  const ok = violations.length === 0 && before.tier === "T3" && before.historyDays === 0 && after.stamped === 0 && !after.inDigest && Boolean(after.decision) && calls === 0;
  return {
    ok,
    output: { before, after: { ...after, decision: after.decision ? { old: JSON.parse(after.decision.old_json), new: JSON.parse(after.decision.new_json) } : null } },
    violations,
    metrics: { model_calls: calls, tier_accuracy: after.tier === "T1" ? 1 : 0, requeued: after.requeued },
    gateObservations: [{ gateId: "tier_accuracy", passed: after.tier === "T1", counted: true }],
  };
};

const CASES: Record<string, CaseFn> = {
  "TIER-01": tier01,
  "TIER-02": tier02,
  "TIER-03": tier03,
  "TIER-04": tier04,
};

/** Rows the CaseWorld sweep does not know about: promotion decisions for the case's streams. */
function cleanupDecisions(w: CaseWorld): void {
  getDb().prepare(`DELETE FROM decisions WHERE target_kind = 'stream' AND target_id LIKE ?`).run(`%:st:${w.prefix}%`);
}

/** One TIER case; `deps` lets a test hand in a stub provider (the CLI passes none → the real one). */
export async function runTierCase(fixture: Fixture, deps: TieringDeps = {}): Promise<ExecutorResult> {
  const run = CASES[fixture.id];
  if (!run) throw new Error(`TIER executor: no case for ${fixture.id}`);
  const w = new CaseWorld(fixture.id);
  try {
    const result = await run(fixture, w, deps);
    const note = fixture.mode === "code" ? "deterministic; zero model calls (tiers/tiering.ts code rules + tiers/promote.ts)" : "tier.v1 through the traced, pooled provider path; second pass from the stream cache";
    return { ...result, notes: [...(result.notes ?? []), note] };
  } finally {
    cleanupDecisions(w);
    w.cleanup();
  }
}

/** The executor registered for pass `tier` (TIER). */
export const tierExecutor: Executor = async ({ fixture }) => runTierCase(fixture);
