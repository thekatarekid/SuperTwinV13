// ===========================================================================
// V6 tiering — TIER-01..04 as vitest (GoldenEvals V6 P1 §5.18; S3.8).
//
//   TIER-01  a replied-in group is tier 1                          code
//   TIER-02  a never-replied 180-member group is tier 3           code
//   TIER-03  HDFC with OTPs and bills is tier 2, ONE cached call   model (stubbed here)
//   TIER-04  a reply promotes instantly and retroactively          code
//
// ZERO live model calls: the provider is a stub that counts. Everything runs
// over a real migrated SQLite DB through the real writers (appendEvents).
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDb } from "../db/connection.js";
import { appendEvents } from "../db/eventlog.js";
import type { Provider, ProviderResult, SendOptions } from "../providers/types.js";
import { planDigest } from "../scheduler/v6/digest.js";
import { planHistory } from "../scheduler/v6/history.js";
import { append, msgAt, openScratchDb, streamIdOf, type ScratchDb } from "../scheduler/v6/testutil.js";
import { hasTraceContext } from "../traces/context.js";
import { readTier } from "./derive.js";
import { pendingRequeueCount, promoteOnEngagement, requeueStreamHistory, tierRank } from "./promote.js";
import {
  businessCharacter,
  countUserMessagesV6,
  decideTierByCode,
  inferKindFromStreamId,
  readFactsV6,
  startTieringJob,
  tierAllStreams,
  tierStream,
} from "./tiering.js";

let db: ScratchDb;
beforeEach(() => {
  db = openScratchDb("supertwin-tiering-");
});
afterEach(() => db.close());

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 86_400_000;
const at = (daysAgo: number, hour = 9) => NOW - daysAgo * DAY + (hour - 12) * 3_600_000;

const ZERO_USAGE = { inputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };

/** A counting stub — the only "model" these tests ever see. */
function stubTierProvider(answer: string, seen: { calls: number; traced?: boolean; messages: string[] }): Provider {
  return {
    id: "stub",
    async send(opts: SendOptions): Promise<ProviderResult> {
      seen.calls += 1;
      seen.traced = hasTraceContext();
      seen.messages.push(opts.message);
      opts.onEvent({ type: "delta", text: answer });
      return { sessionId: "s", usage: ZERO_USAGE, freshFallback: false, status: "ok" };
    },
    cancel: () => false,
  };
}

function markBusiness(streamId: string, label: string): void {
  getDb().prepare(`UPDATE streams SET is_business = 1, label = ?, stream_kind = 'business' WHERE id = ?`).run(label, streamId);
}

/** Stamp every row of a stream as already understood (digested / dispatched). */
function stampAll(streamId: string, whenMs = NOW - DAY): void {
  getDb().prepare(`UPDATE events SET dispatched_at = ? WHERE stream_id = ?`).run(new Date(whenMs).toISOString(), streamId);
}

const HDFC_LINES = [
  "Your OTP for HDFC Bank NetBanking is 482913. Valid for 10 minutes. Do not share.",
  "HDFC Bank: Rs.24,110.00 debited from a/c **4321 on 05-Aug-26 for Credit Card bill payment.",
  "Your HDFC Bank Credit Card statement for Aug is ready. Total due Rs.31,204 by 03-Sep.",
  "Alert: Rs.2,499.00 spent on HDFC Card **4321 at AMAZON on 12-Aug-26.",
  "Your OTP is 118273 for txn of Rs.1,200 at SWIGGY. Valid 5 mins.",
  "HDFC Bank: EMI of Rs.8,400 for loan **7781 due on 15-Aug-26.",
];

describe("the code rules (TIER-01, TIER-02)", () => {
  it("TIER-01 · a replied-in group is tier 1 — code, no model", async () => {
    const key = "goa-gang@g.us";
    append([
      msgAt(key, at(3), "goa december mein chalte hai?", { actor: "contact:rohan" }),
      msgAt(key, at(3, 10), "haan chalo, dates lock karte hai", { actor: "self" }),
      msgAt(key, at(2), "villa dekh lo", { actor: "contact:tanvi" }),
    ]);
    const sid = streamIdOf("wa", key);
    expect(countUserMessagesV6(sid)).toBe(1);
    const facts = readFactsV6(sid)!;
    expect(decideTierByCode(facts)).toMatchObject({ tier: "T1", rule: "engaged", needsModel: false });

    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const r = await tierStream(sid, { provider: stubTierProvider("{}", seen) });
    expect(r.change.to).toBe("T1");
    expect(r.modelCalls).toBe(0);
    expect(seen.calls).toBe(0);
    expect(readTier(sid)).toBe("T1");
  });

  it("TIER-02 · a never-replied 180-member group is tier 3 — code, no model", async () => {
    const key = "mumbai-startup-founders@g.us";
    const envs = [];
    for (let i = 0; i < 180; i++) {
      envs.push(msgAt(key, at(30) + i * 600_000, `member ${i}: anyone hiring a growth lead?`, { actor: `contact:m${i}`, origin: "backfill" }));
    }
    append(envs);
    const sid = streamIdOf("wa", key);
    // appendEvents leaves stream_kind NULL — the key says group.
    expect(inferKindFromStreamId(sid)).toBe("group");
    expect(inferKindFromStreamId(streamIdOf("wa", "919800000001@s.whatsapp.net"))).toBe("dm");
    expect(inferKindFromStreamId("browser:st:browser:chrome:default:amazon.in:2026-08-28")).toBe("");

    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const r = await tierStream(sid, { provider: stubTierProvider("{}", seen) });
    expect(r.decision).toMatchObject({ tier: "T3", rule: "group_never_replied", source: "code" });
    expect(r.modelCalls).toBe(0);
    expect(seen.calls).toBe(0);
    expect(readTier(sid)).toBe("T3");
    // and it is now digest-lane work, not history-lane work
    expect(planHistory().filter((b) => b.streamId === sid)).toHaveLength(0);
    expect(planDigest({ nowMs: NOW }).some((b) => b.streamId === sid)).toBe(true);
  });

  it("the user's own activity (screen, browser, docs) is tier 1 without a model", async () => {
    const [id] = append([
      {
        ts: new Date(at(1)).toISOString(),
        source: "screen",
        kind: "screen.text",
        origin: "live",
        streamKey: "screen:com.apple.Notes:s1",
        actor: "self",
        roles: { sender: "self", audience: [], receiver: [], mentions: [] },
        payload: { text: "packing list for goa", app: "com.apple.Notes" },
      },
    ]);
    expect(id).toBeTruthy();
    const r = await tierStream(streamIdOf("screen", "screen:com.apple.Notes:s1"));
    expect(r.change.to).toBe("T1");
    expect(r.modelCalls).toBe(0);
  });
});

describe("the business split (TIER-03)", () => {
  it("TIER-03 · HDFC with OTPs and bills is tier 2 via ONE cached, traced tier.v1 call", async () => {
    const key = "hdfcbank@s.whatsapp.net";
    append(HDFC_LINES.map((t, i) => msgAt(key, at(20 - i), t, { actor: "contact:hdfc", origin: "backfill" })));
    const sid = streamIdOf("wa", key);
    markBusiness(sid, "HDFC Bank");
    expect(decideTierByCode(readFactsV6(sid)!)).toMatchObject({ tier: null, needsModel: true, rule: "business_needs_model" });

    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const provider = stubTierProvider(JSON.stringify({ tier: 2, reason: "active account with OTPs and bills", confidence: 0.93 }), seen);

    const first = await tierStream(sid, { provider });
    expect(first.modelCalls).toBe(1);
    expect(first.cached).toBe(false);
    expect(first.decision).toMatchObject({ tier: "T2", source: "tier.v1", confidence: 0.93 });
    expect(readTier(sid)).toBe("T2");
    expect(seen.traced).toBe(true);
    // the sample went inside ONE untrusted block; the bank's lines are data
    expect(seen.messages[0]).toContain("BUSINESS SENDER HDFC Bank");
    expect(seen.messages[0]).toContain("<untrusted>");
    expect(seen.messages[0]).toContain("482913");

    // Same channel, same character → served from the cache, no call.
    const second = await tierStream(sid, { provider });
    expect(second.modelCalls).toBe(0);
    expect(second.cached).toBe(true);
    expect(second.change.to).toBe("T2");
    expect(seen.calls).toBe(1);

    // One more bill of the same kind changes nothing about the character.
    append([msgAt(key, at(0, 8), "HDFC Bank: Rs.560.00 debited for UPI to ZOMATO on 28-Aug-26.", { actor: "contact:hdfc" })]);
    const third = await tierStream(sid, { provider });
    expect(third.modelCalls).toBe(0);
    expect(seen.calls).toBe(1);

    // The one call is in the ledger under its version.
    const runs = getDb().prepare(`SELECT pass, role, status FROM runs`).all();
    expect(runs).toEqual([{ pass: "tier.v1", role: "classify", status: "ok" }]);
  });

  it("the cache key is the channel's character, not its newest line", () => {
    const bills = HDFC_LINES;
    expect(businessCharacter(bills, 6)).toBe(businessCharacter([...bills].reverse(), 7));
    const promo = ["FLAT 60% OFF this weekend! Use code WEEKEND60. Unsubscribe to stop", "Mega sale is LIVE. Shop now. Reply STOP to opt out"];
    expect(businessCharacter(promo, 2)).not.toBe(businessCharacter(bills, 6));
  });

  it("an unusable answer defaults to T2 WITHOUT caching, so it is asked again", async () => {
    const key = "unknownbiz@s.whatsapp.net";
    append(HDFC_LINES.slice(0, 3).map((t, i) => msgAt(key, at(10 - i), t, { actor: "contact:biz", origin: "backfill" })));
    const sid = streamIdOf("wa", key);
    markBusiness(sid, "Unknown Biz");
    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const provider = stubTierProvider("I would say it is probably a bank", seen);
    const r1 = await tierStream(sid, { provider });
    expect(r1.defaulted).toBe(true);
    expect(r1.change.to).toBe("T2");
    const r2 = await tierStream(sid, { provider });
    expect(r2.modelCalls).toBe(1); // asked again — nothing was cached
    expect(seen.calls).toBe(2);
  });

  it("a business the user wrote to is tier 1 by code — the model is never asked", async () => {
    const key = "myntra@s.whatsapp.net";
    append([
      msgAt(key, at(5), "Your order #MYN123 has shipped", { actor: "contact:myntra" }),
      msgAt(key, at(4), "where is my order?", { actor: "self" }),
    ]);
    const sid = streamIdOf("wa", key);
    markBusiness(sid, "Myntra");
    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const r = await tierStream(sid, { provider: stubTierProvider("{}", seen) });
    expect(r.change.to).toBe("T1");
    expect(seen.calls).toBe(0);
  });
});

describe("promotion — instant and retroactive (TIER-04)", () => {
  function seedDigestedGroup(key: string, n = 12): string {
    const envs = [];
    for (let i = 0; i < n; i++) {
      envs.push(msgAt(key, at(40 - i * 2), `society notice ${i}: maintenance due by the 5th`, { actor: "contact:secretary", origin: "backfill" }));
    }
    append(envs);
    const sid = streamIdOf("wa", key);
    getDb().prepare(`UPDATE streams SET tier = 'T3', tier_rule = 'group_never_replied', tier_source = 'code' WHERE id = ?`).run(sid);
    stampAll(sid); // every row already digested
    return sid;
  }

  it("TIER-04 · the user's first reply flips a tier-3 group to tier 1 and re-queues its history", () => {
    const key = "sunrise-402@g.us";
    const sid = seedDigestedGroup(key);
    expect(readTier(sid)).toBe("T3");
    expect(pendingRequeueCount(sid)).toBe(12);
    expect(planHistory().filter((b) => b.streamId === sid)).toHaveLength(0);

    // The reply goes through the single writer — promotion rides the same call.
    appendEvents(
      [msgAt(key, at(0, 11), "is the plumber contact still valid? my kitchen sink is leaking", { actor: "self" })],
      NOW,
    );

    // INSTANT: the tier is 1 before any dispatcher tick.
    const row = getDb().prepare(`SELECT tier, tier_rule, tier_source FROM streams WHERE id = ?`).get(sid) as Record<string, string>;
    expect(row).toMatchObject({ tier: "T1", tier_rule: "engaged_promotion", tier_source: "code" });

    // RETROACTIVE: every stamped row lost its mark and is backfill again.
    expect(pendingRequeueCount(sid)).toBe(0);
    const flipped = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id = ? AND dispatched_at IS NULL AND origin = 'backfill'`)
      .get(sid) as { n: number };
    expect(flipped.n).toBe(12);
    // …and the history lane sees the days again (the reply itself is live-lane work).
    const days = planHistory().filter((b) => b.streamId === sid);
    expect(days.length).toBeGreaterThan(0);
    expect(days.reduce((s, b) => s + b.events.length, 0)).toBe(12);
    // nothing is digest work any more
    expect(planDigest({ nowMs: NOW, includeCurrentWeek: true }).some((b) => b.streamId === sid)).toBe(false);

    // Logged and reversible.
    const decision = getDb()
      .prepare(`SELECT old_json, new_json FROM decisions WHERE target_id = ? AND pass = 'code:tier-promotion'`)
      .get(sid) as { old_json: string; new_json: string };
    expect(JSON.parse(decision.old_json)).toEqual({ tier: "T3" });
    expect(JSON.parse(decision.new_json)).toMatchObject({ tier: "T1", requeued: 12 });

    // Nothing deleted.
    const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM events WHERE stream_id = ?`).get(sid) as { n: number }).n;
    expect(total).toBe(13);
  });

  it("promotion is idempotent at tier 1 and a no-op for an unknown stream", () => {
    const sid = seedDigestedGroup("quiet@g.us", 3);
    const first = promoteOnEngagement(sid, new Date(NOW).toISOString(), NOW);
    expect(first).toMatchObject({ promoted: true, from: "T3", to: "T1", requeued: 3 });
    const again = promoteOnEngagement(sid, new Date(NOW + 1).toISOString(), NOW);
    expect(again).toMatchObject({ promoted: false, from: "T1", requeued: 0, decisionId: null });
    expect(promoteOnEngagement("wa:st:never-seen@g.us", new Date(NOW).toISOString(), NOW).promoted).toBe(false);
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM decisions WHERE pass = 'code:tier-promotion'`).get()).toEqual({ n: 1 });
  });

  it("the re-queue is the S1.2 replay: chunked, resumable, archive rows untouched", () => {
    const sid = seedDigestedGroup("big@g.us", 25);
    // one archive row (outside the UNDERSTAND window) stays stamped forever
    getDb().prepare(`UPDATE events SET origin = 'archive' WHERE rowid = (SELECT MIN(rowid) FROM events WHERE stream_id = ?)`).run(sid);
    const partial = requeueStreamHistory(sid, { chunk: 10, maxChunks: 1 });
    expect(partial).toMatchObject({ requeued: 10, chunks: 1 });
    expect(pendingRequeueCount(sid)).toBe(14); // 24 non-archive stamped − 10 flipped; the archive row is outside the predicate
    const rest = requeueStreamHistory(sid, { chunk: 10 });
    expect(rest.requeued).toBe(14);
    expect(pendingRequeueCount(sid)).toBe(0);
    const archive = getDb().prepare(`SELECT dispatched_at FROM events WHERE stream_id = ? AND origin = 'archive'`).get(sid) as { dispatched_at: string | null };
    expect(archive.dispatched_at).not.toBeNull();
  });

  it("tiering a stream UP through the model path re-queues too (a T4 that turns out to be a bill sender)", async () => {
    const key = "acmebills@s.whatsapp.net";
    append(HDFC_LINES.map((t, i) => msgAt(key, at(20 - i), t, { actor: "contact:acme", origin: "backfill" })));
    const sid = streamIdOf("wa", key);
    markBusiness(sid, "Acme");
    getDb().prepare(`UPDATE streams SET tier = 'T4', tier_source = 'code', tier_rule = 'seed' WHERE id = ?`).run(sid);
    stampAll(sid);
    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const r = await tierStream(sid, { provider: stubTierProvider(JSON.stringify({ tier: 2, reason: "bills", confidence: 0.9 }), seen) });
    expect(r.change).toMatchObject({ from: "T4", to: "T2", changed: true });
    expect(r.requeued).toBe(HDFC_LINES.length);
    expect(tierRank("T2")).toBeLessThan(tierRank("T4"));
    expect(tierRank(null)).toBe(5);
  });
});

describe("the boot pass and the job", () => {
  it("tierAllStreams tiers every stream, asks the model only for never-replied businesses, and reports coverage", async () => {
    append([
      msgAt("goa-gang@g.us", at(3), "plan?", { actor: "contact:rohan" }),
      msgAt("goa-gang@g.us", at(3, 10), "yes", { actor: "self" }),
      msgAt("promo@g.us", at(3), "60% off", { actor: "contact:x", origin: "backfill" }),
    ]);
    append(HDFC_LINES.map((t, i) => msgAt("hdfcbank@s.whatsapp.net", at(20 - i), t, { actor: "contact:hdfc", origin: "backfill" })));
    markBusiness(streamIdOf("wa", "hdfcbank@s.whatsapp.net"), "HDFC Bank");
    const seen: { calls: number; traced?: boolean; messages: string[] } = { calls: 0, messages: [] };
    const provider = stubTierProvider(JSON.stringify({ tier: 2, reason: "bills", confidence: 0.9 }), seen);

    const report = await tierAllStreams({ provider });
    expect(report.streams).toBe(3);
    expect(report.byTier).toEqual({ T1: 1, T2: 1, T3: 1, T4: 0 });
    expect(report.modelCalls).toBe(1);
    expect(report.coverage).toBe(1);

    const again = await tierAllStreams({ provider });
    expect(again.modelCalls).toBe(0);
    expect(again.cached).toEqual([streamIdOf("wa", "hdfcbank@s.whatsapp.net")]);
    expect(seen.calls).toBe(1);
  });

  it("startTieringJob runs one pass now, never overlaps, and stops cleanly", async () => {
    append([msgAt("promo@g.us", at(3), "60% off", { actor: "contact:x", origin: "backfill" })]);
    const lines: string[] = [];
    const job = startTieringJob({ intervalMs: 60_000, log: (l) => lines.push(l), deps: { provider: stubTierProvider("{}", { calls: 0, messages: [] }) } });
    const a = job.runNow();
    const b = job.runNow();
    expect(b).toBe(a); // fenced: the in-flight pass is reused
    const report = await a;
    expect(report.byTier.T3).toBe(1);
    expect(lines.some((l) => l.startsWith("[tiers] 1/1 streams"))).toBe(true);
    job.stop();
  });
});
