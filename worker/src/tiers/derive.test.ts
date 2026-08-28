// ===========================================================================
// Tier assignment, the boot backfill and the promotion re-scan
// (arch §9.3; evals B-001…B-022, B-039, B-047…B-050).
//
// The three cases the build doc names, over a real SQLite DB with real
// migrations:
//
//   * a T3 -> T1 promotion orphans ZERO events (the 10 lost messages),
//   * tier order is respected (priority.test.ts owns the ordering itself),
//   * a T4 channel's real obligation is still enqueued in full.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet, insertEvent, selfIdentityKey, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { noteIngestedEvent, readWatermark } from "../db/watermarks.js";
import type { Ti1Verdict } from "./derive.js";
import {
  assertTierCoverage,
  backfillTiers,
  deriveTier,
  readStreamFacts,
  readTier,
  retierStream,
  tierCoverage,
  TierCoverageError,
} from "./derive.js";
import { LANE_ENTRY_STAGES, enqueueStreamEvents, orphanedEvents, pendingEvents } from "./rescan.js";
import { computePriority, horizonFor, tierOfPriority } from "./priority.js";

const SOURCE = "whatsapp";
const SELF = "me@s.whatsapp.net";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-tiers-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  closeDb();
  runMigrations();
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
  appStateSet(selfIdentityKey(SOURCE), SELF);
  upsertActor({ sourceId: SOURCE, sourceExtId: SELF, displayName: "Me", isSelf: true });
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stream(ext: string, kind: string, isBusiness = false): string {
  return upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind, isBusiness });
}

let seq = 0;

function say(streamId: string, who: string, text: string, ts = "2026-08-14T09:00:00.000Z"): string {
  seq += 1;
  const actorId = upsertActor({ sourceId: SOURCE, sourceExtId: who, displayName: who });
  const external = `${streamId}/${seq}`;
  const res = insertEvent({
    externalId: external,
    sourceId: SOURCE,
    sourceType: SOURCE,
    streamId,
    actorId,
    ts,
    kind: "message",
    text,
    mediaPath: null,
    rawJson: null,
    isHistorical: true,
  });
  noteIngestedEvent(streamId, ts, { historical: true, externalId: external });
  return res.id;
}

const BILL = "Statement for Aug is ready. Total due Rs.24,110 by 05-Sep";
const OFFER = "FLAT 60% OFF this weekend! Use code WEEKEND60. Unsubscribe to stop";

// ---------------------------------------------------------------------------

describe("where the tier is kept (0023_stream_tiers)", () => {
  it("puts the tier and its provenance on `streams`, not on the legacy mirror", () => {
    const columns = (
      getDb().prepare(`PRAGMA table_info(streams)`).all() as { name: string; dflt_value: string | null }[]
    ).map((c) => c.name);
    for (const column of [
      "is_business",
      "tier",
      "tier_rule",
      "tier_source",
      "tier_confidence",
      "tier_reason",
      "tier_assigned_at",
      "tier_sample_hash",
    ]) {
      expect(columns).toContain(column);
    }
  });

  it("starts every stream with tier NULL — the backfill is what fills it", () => {
    const s = stream("pranjali@x", "dm");
    expect(readTier(s)).toBeNull();
    expect(tierCoverage()).toMatchObject({ streams: 1, assigned: 0, unassigned: [s] });
  });

  it("carries is_business onto the stream row, so no tier rule reads `channels`", () => {
    const biz = stream("hdfc@x", "dm", true);
    expect(readStreamFacts(biz)!.isBusiness).toBe(true);
    // Sticky: a later frame that forgets the flag cannot un-business it.
    upsertStream({ sourceId: SOURCE, sourceExtId: "hdfc@x", name: "HDFC Bank", kind: "dm" });
    expect(readStreamFacts(biz)!.isBusiness).toBe(true);
  });
});

describe("the [CODE] rules (§9.3)", () => {
  it("puts a 1:1 with a person in T1", () => {
    const s = stream("pranjali@x", "dm");
    say(s, "pranjali@x", "dinner tomorrow?");
    expect(deriveTier(readStreamFacts(s)!).tier).toBe("T1");
    expect(deriveTier(readStreamFacts(s)!).rule).toBe("dm_person");
  });

  it("puts a group the user has replied in into T1, and one they never have into T3", () => {
    const engaged = stream("ghar+@g", "group");
    say(engaged, "mom@x", "who is coming");
    say(engaged, SELF, "me");
    const passive = stream("society@g", "group");
    say(passive, "secretary@x", "water supply off tomorrow");

    expect(readStreamFacts(engaged)!.userMessageCount).toBe(1);
    expect(deriveTier(readStreamFacts(engaged)!).tier).toBe("T1");
    expect(readStreamFacts(passive)!.userMessageCount).toBe(0);
    expect(deriveTier(readStreamFacts(passive)!).tier).toBe("T3");
  });

  it("splits business channels by content and asks nobody when the sample is one-sided", () => {
    const bank = stream("hdfc@x", "dm", true);
    say(bank, "hdfc@x", BILL);
    say(bank, "hdfc@x", "Rs.3398.23 debited from a/c XX4412 on 11-Aug");
    const shop = stream("promo@x", "dm", true);
    say(shop, "promo@x", OFFER);
    say(shop, "promo@x", "Limited time - 40% off everything. Shop now");

    const report = backfillTiers({ now: NOW });
    expect(readTier(bank)).toBe("T2");
    expect(readTier(shop)).toBe("T4");
    expect(report.ambiguous).toEqual([]);
    expect(report.modelVerdicts).toBe(0);
  });
});

describe("the boot backfill (§9.3 rule 4)", () => {
  it("leaves no stream without a tier, and says so", () => {
    stream("a@x", "dm");
    stream("b@g", "group");
    const bank = stream("hdfc@x", "dm", true);
    say(bank, "hdfc@x", BILL);

    const report = backfillTiers({ now: NOW });
    expect(report.streams).toBe(3);
    expect(report.assigned).toBe(3);
    expect(report.coverage).toBe(1);
    expect(report.unassigned).toEqual([]);
    expect(tierCoverage().coverage).toBe(1);
  });

  it("asks P-TI1 once per ambiguous channel and caches the verdict on the stream", () => {
    const mixed = stream("zomato@x", "dm", true);
    say(mixed, "zomato@x", OFFER);
    say(mixed, "zomato@x", "Your order from Meghana Foods has been delivered");

    let calls = 0;
    const resolve = (channels: { streamId: string }[]): Ti1Verdict[] => {
      calls += 1;
      return channels.map((c) => ({
        alias: "c1",
        streamId: c.streamId,
        cls: "pm" as const,
        label: "promotional",
        confidence: 0.85,
        reason: "predominantly campaign offers",
        raw: "J|c1|pm|0.85|predominantly campaign offers",
      }));
    };

    const report = backfillTiers({ now: NOW, resolveAmbiguous: resolve });
    expect(calls).toBe(1);
    expect(report.ambiguous).toEqual([mixed]);
    expect(readTier(mixed)).toBe("T4");

    const row = getDb().prepare(`SELECT tier_source, tier_confidence, tier_reason FROM streams WHERE id = ?`).get(mixed);
    expect(row).toMatchObject({
      tier_source: "p-ti1",
      tier_confidence: 0.85,
      tier_reason: "predominantly campaign offers",
    });

    // Cached: a second pass over the same sample asks nobody.
    const second = backfillTiers({ now: NOW, resolveAmbiguous: resolve });
    expect(calls).toBe(1);
    expect(second.cached).toEqual([mixed]);
    expect(readTier(mixed)).toBe("T4");
  });

  it("re-asks only when the channel's character changes", () => {
    const mixed = stream("myntra@x", "dm", true);
    say(mixed, "myntra@x", OFFER, "2026-08-10T09:00:00.000Z");
    say(mixed, "myntra@x", "Your order MY8817 has been shipped", "2026-08-10T10:00:00.000Z");

    let calls = 0;
    const resolve = (channels: { streamId: string }[]): Ti1Verdict[] => {
      calls += 1;
      return channels.map((c) => ({
        alias: "c1",
        streamId: c.streamId,
        cls: "pm" as const,
        label: "promotional",
        confidence: 0.8,
        reason: "campaign copy",
        raw: "J|c1|pm|0.8|campaign copy",
      }));
    };
    backfillTiers({ now: NOW, resolveAmbiguous: resolve });
    expect(calls).toBe(1);

    // The channel starts sending this person's own bills: a new sample, a new
    // fingerprint, and the verdict is worth re-asking.
    say(mixed, "myntra@x", "Amount due Rs.2,110 by 09-Sep for order MY8817", "2026-08-14T10:00:00.000Z");
    backfillTiers({ now: NOW, resolveAmbiguous: resolve });
    expect(calls).toBe(2);
  });

  it("defaults an unanswered ambiguous channel to tx rather than leaving it NULL", () => {
    const mixed = stream("jio@x", "dm", true);
    say(mixed, "jio@x", OFFER);
    say(mixed, "jio@x", "Your bill is ready. Total due Rs.399 by 22-Aug");

    const report = backfillTiers({ now: NOW });
    expect(report.defaulted).toEqual([mixed]);
    expect(readTier(mixed)).toBe("T2");
    expect(report.coverage).toBe(1);
  });

  it("throws when a stream would be left without a tier", () => {
    stream("a@x", "dm");
    getDb().prepare(`UPDATE streams SET tier = NULL`).run();
    expect(() => assertTierCoverage()).toThrow(TierCoverageError);
  });
});

describe("the T3 -> T1 promotion re-scan (§9.3 rule 3)", () => {
  function passiveGroupWithHistory(): string {
    const s = stream("goacrew@g", "group");
    for (let i = 0; i < 10; i += 1) {
      say(s, "rahul@x", `plan message ${i}`, `2026-08-1${i % 5}T08:0${i % 6}:00.000Z`);
    }
    backfillTiers({ now: NOW });
    expect(readTier(s)).toBe("T3");
    return s;
  }

  it("orphans zero events — the defect that lost 10 real messages", () => {
    const s = passiveGroupWithHistory();
    expect(pendingEvents(s)).toHaveLength(10);

    say(s, SELF, "im in", "2026-08-15T11:00:00.000Z");
    const { change, rescan } = retierStream(s, { now: NOW });

    expect(change).toMatchObject({ from: "T3", to: "T1", changed: true });
    expect(rescan!.orphans).toEqual([]);
    expect(orphanedEvents(s)).toEqual([]);
    // Every unprocessed event — all 11 — is reachable again, at T1.
    expect(rescan!.requeued).toHaveLength(11);
    for (const priority of Object.values(rescan!.enqueue.priorities)) {
      expect(tierOfPriority(priority)).toBe("T1");
    }
    const rows = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM work_queue WHERE state = 'ready'`)
      .get() as { n: number };
    expect(rows.n).toBe(11 * LANE_ENTRY_STAGES.length);
  });

  it("counts an event parked in a state no lane dequeues as orphaned", () => {
    const s = passiveGroupWithHistory();
    const stranded = pendingEvents(s)[0]!.id;
    getDb().prepare(`UPDATE work_queue SET state = 'abandoned' WHERE unit_id = ?`).run(stranded);
    expect(orphanedEvents(s)).toEqual([stranded]);

    // …and that the re-scan is what makes it reachable again.
    say(s, SELF, "im in", "2026-08-15T11:00:00.000Z");
    const { rescan } = retierStream(s, { now: NOW });
    expect(rescan!.orphans).toEqual([]);
    expect(rescan!.requeued).toContain(stranded);
  });

  it("never moves a watermark backwards", () => {
    const s = passiveGroupWithHistory();
    say(s, SELF, "im in", "2026-08-15T11:00:00.000Z");
    const before = readWatermark(s)!;
    const { rescan } = retierStream(s, { now: NOW });

    expect(rescan!.watermarkRegressions).toEqual([]);
    expect(rescan!.liveDirection).toBe("same");
    expect(rescan!.backfillDirection).toBe("same");
    const after = readWatermark(s)!;
    expect(after.live_high_ts).toBe(before.live_high_ts);
    expect(after.backfill_low_ts).toBe(before.backfill_low_ts);
  });

  it("leaves finished work finished — a re-scan is not a redo", () => {
    const s = passiveGroupWithHistory();
    const done = pendingEvents(s)[0]!.id;
    // The T3 backfill already enqueued this stream; mark one event's rows done,
    // the way the lanes would when they finish it.
    getDb().prepare(`UPDATE work_queue SET state = 'done' WHERE unit_id = ?`).run(done);
    say(s, SELF, "im in", "2026-08-15T11:00:00.000Z");
    const { rescan } = retierStream(s, { now: NOW });

    expect(rescan!.requeued).not.toContain(done);
    const states = getDb()
      .prepare(`SELECT DISTINCT state FROM work_queue WHERE unit_id = ?`)
      .all(done) as { state: string }[];
    expect(states).toEqual([{ state: "done" }]);
  });
});

describe("tiering orders, never filters (§9.3 rule 1)", () => {
  it("enqueues a T4 channel's real bill for exactly the same stages as a T1 message", () => {
    const promo = stream("bigbasket@x", "dm", true);
    say(promo, "bigbasket@x", OFFER, "2026-08-14T09:00:00.000Z");
    say(promo, "bigbasket@x", "Limited time! 30% off. Shop now", "2026-08-14T10:00:00.000Z");
    const bill = say(
      promo,
      "bigbasket@x",
      "Your order OD8841 is out for delivery. Amount due Rs.1,240 by 20-Aug",
      "2026-08-14T11:00:00.000Z",
    );
    const friend = stream("gargi@x", "dm");
    const chat = say(friend, "gargi@x", "coffee?", "2026-08-14T11:00:00.000Z");

    // A campaign channel with one real obligation in it is exactly §12.11's
    // ambiguous case, so the verdict comes from P-TI1: pm, because "one
    // delivery notice does not change the channel's character".
    backfillTiers({
      now: NOW,
      resolveAmbiguous: (channels) =>
        channels.map((c) => ({
          alias: "c1",
          streamId: c.streamId,
          cls: "pm" as const,
          label: "promotional",
          confidence: 0.85,
          reason: "predominantly campaign offers",
          raw: "J|c1|pm|0.85|predominantly campaign offers",
        })),
    });
    expect(readTier(promo)).toBe("T4");

    const t4 = enqueueStreamEvents(promo, { now: NOW });
    const t1 = enqueueStreamEvents(friend, { now: NOW });

    // Same stages, every event kept, nothing filtered out by tier.
    const stagesFor = (eventId: string): string[] =>
      (
        getDb()
          .prepare(`SELECT stage FROM work_queue WHERE unit_id = ? ORDER BY stage`)
          .all(eventId) as { stage: string }[]
      ).map((r) => r.stage);
    expect(stagesFor(bill)).toEqual(stagesFor(chat));
    expect(t4.events).toBe(3);
    expect(t4.orphans).toEqual([]);

    // It simply waits its turn: same instant, lower priority.
    expect(t4.priorities[bill]!).toBeLessThan(t1.priorities[chat]!);
    expect(t4.priorities[bill]).toBe(
      computePriority({
        tier: "T4",
        horizon: horizonFor("2026-08-14T11:00:00.000Z", NOW),
        ts: "2026-08-14T11:00:00.000Z",
        now: NOW,
      }),
    );
  });
});
