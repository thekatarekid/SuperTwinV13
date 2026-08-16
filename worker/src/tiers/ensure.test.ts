// ===========================================================================
// `ensureTiers` — the caller §9.3 rule 4 never had (arch §9.3, §12.11).
//
// derive.test.ts proves the RULES. This file proves the WIRING: that something
// actually runs them over a real database, that it is safe to run on a cold
// install and again after the backfill lands, and that it does not take the
// worker down when coverage cannot be reached.
// ===========================================================================

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDb, getDb, runMigrations } from "../db/connection.js";
import { appStateSet, insertEvent, selfIdentityKey, upsertActor, upsertSource, upsertStream } from "../db/ingest.js";
import { noteIngestedEvent } from "../db/watermarks.js";
import type { Ti1Channel, Ti1Verdict } from "../prompts/p-ti1.js";
import { ambiguousChannels, ensureTiers, TIER_MODEL_KEY } from "./ensure.js";
import { readTier, tierCoverage } from "./derive.js";

const SOURCE = "whatsapp";
const SELF = "me@s.whatsapp.net";
const NOW = Date.parse("2026-08-15T12:00:00.000Z");

const BILL = "Statement for Aug is ready. Total due Rs.24,110 by 05-Sep";
const OFFER = "FLAT 60% OFF this weekend! Use code WEEKEND60. Unsubscribe to stop";

let tmpDir: string;
let seq = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "supertwin-ensure-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "st.db");
  delete process.env.SUPERTWIN_TIER_MODEL;
  closeDb();
  runMigrations();
  upsertSource({ id: SOURCE, type: SOURCE, name: "WhatsApp" });
  appStateSet(selfIdentityKey(SOURCE), SELF);
  upsertActor({ sourceId: SOURCE, sourceExtId: SELF, displayName: "Me", isSelf: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

function stream(ext: string, kind: string, isBusiness = false): string {
  return upsertStream({ sourceId: SOURCE, sourceExtId: ext, name: ext, kind, isBusiness });
}

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

/** The install the live DB is: a source, a handful of streams, real events. */
function fixture(): { ids: string[]; mixed: string } {
  const friend = stream("pranjali@x", "dm");
  say(friend, "pranjali@x", "dinner tomorrow?");
  const engaged = stream("ghar+@g", "group");
  say(engaged, "mom@x", "who is coming");
  say(engaged, SELF, "me");
  const passive = stream("society@g", "group");
  say(passive, "secretary@x", "water supply off tomorrow");
  const bank = stream("hdfc@x", "dm", true);
  say(bank, "hdfc@x", BILL);
  const shop = stream("promo@x", "dm", true);
  say(shop, "promo@x", OFFER);
  // §12.11's ambiguous case: campaign copy AND this person's own order.
  const mixed = stream("zomato@x", "dm", true);
  say(mixed, "zomato@x", OFFER);
  say(mixed, "zomato@x", "Your order from Meghana Foods has been delivered");
  return { ids: [friend, engaged, passive, bank, shop, mixed], mixed };
}

// ---------------------------------------------------------------------------

describe("ensureTiers (§9.3 rule 4 — the regression that shipped twice)", () => {
  it("leaves 100% of streams with a non-NULL tier, and no stream behind", async () => {
    const { ids } = fixture();
    expect(tierCoverage().coverage).toBe(0);

    const result = await ensureTiers({ now: NOW, reason: "test" });

    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(result.streams).toBe(ids.length);
    expect(result.assigned).toBe(ids.length);
    expect(result.coverage).toBe(1);
    expect(result.unassigned).toEqual([]);
    for (const id of ids) expect(readTier(id)).not.toBeNull();
    const nulls = getDb().prepare(`SELECT COUNT(*) AS n FROM streams WHERE tier IS NULL`).get() as {
      n: number;
    };
    expect(nulls.n).toBe(0);
  });

  it("buys nothing from the model by default — the unsure default is free", async () => {
    const { mixed } = fixture();
    const invoke = vi.fn<(c: readonly Ti1Channel[]) => Promise<Ti1Verdict[]>>(async () => []);

    const result = await ensureTiers({ now: NOW, invoke });

    expect(invoke).not.toHaveBeenCalled();
    expect(result.modelCalls).toBe(0);
    expect(result.ambiguous).toBe(1);
    expect(result.defaulted).toBe(1);
    // §12.11: unsure -> tx, never a NULL tier.
    expect(readTier(mixed)).toBe("T2");
    expect(result.coverage).toBe(1);
  });

  it("passes vacuously on a cold install, then covers the streams the backfill creates", async () => {
    // Boot: no streams exist yet — this is why a boot-only call was never enough.
    const boot = await ensureTiers({ now: NOW, reason: "boot" });
    expect(boot).toMatchObject({ ok: true, streams: 0, coverage: 1 });

    // …the WhatsApp backfill then lands, and ingest calls the same function.
    const { ids } = fixture();
    const after = await ensureTiers({ now: NOW, reason: "backfill_complete" });
    expect(after.assigned).toBe(ids.length);
    expect(after.coverage).toBe(1);
  });

  it("is idempotent and free on a second pass — nothing ambiguous is re-asked", async () => {
    fixture();
    const first = await ensureTiers({ now: NOW });
    const tiers = getDb().prepare(`SELECT id, tier FROM streams ORDER BY id`).all();

    const invoke = vi.fn<(c: readonly Ti1Channel[]) => Promise<Ti1Verdict[]>>(async () => []);
    const second = await ensureTiers({ now: NOW, invoke });

    expect(invoke).not.toHaveBeenCalled();
    expect(second.assigned).toBe(first.assigned);
    expect(getDb().prepare(`SELECT id, tier FROM streams ORDER BY id`).all()).toEqual(tiers);
  });
});

describe("the P-TI1 seam (opt-in, bounded)", () => {
  it("asks only about the channels the code rules cannot decide", async () => {
    const { mixed } = fixture();
    expect(ambiguousChannels().map((c) => c.streamId)).toEqual([mixed]);

    const invoke = vi.fn(async (channels: readonly Ti1Channel[]): Promise<Ti1Verdict[]> =>
      channels.map((c) => ({
        alias: "c1",
        streamId: c.streamId,
        cls: "pm" as const,
        label: "promotional",
        confidence: 0.85,
        reason: "predominantly campaign offers",
        raw: "J|c1|pm|0.85|predominantly campaign offers",
      })),
    );

    const result = await ensureTiers({ now: NOW, resolveWithModel: true, invoke });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0]).toHaveLength(1);
    expect(result.modelCalls).toBe(1);
    expect(result.modelVerdicts).toBe(1);
    expect(readTier(mixed)).toBe("T4");
    expect(result.coverage).toBe(1);

    // The verdict is cached on the stream, so the next pass asks nobody.
    const again = await ensureTiers({ now: NOW, resolveWithModel: true, invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(again.cached).toBe(1);
  });

  it("honours the call ceiling and still reaches full coverage", async () => {
    // 12 ambiguous channels — two batches at §12.11's 10-per-call cap.
    for (let i = 0; i < 12; i += 1) {
      const s = stream(`mixed${i}@x`, "dm", true);
      say(s, `mixed${i}@x`, OFFER, "2026-08-14T09:00:00.000Z");
      say(s, `mixed${i}@x`, "Your order OD88 has been delivered", "2026-08-14T10:00:00.000Z");
    }
    const invoke = vi.fn(async (channels: readonly Ti1Channel[]): Promise<Ti1Verdict[]> =>
      channels.map((c) => ({
        alias: "c1",
        streamId: c.streamId,
        cls: "pm" as const,
        label: "promotional",
        confidence: 0.8,
        reason: "campaign copy",
        raw: "J|c1|pm|0.8|campaign copy",
      })),
    );

    const result = await ensureTiers({ now: NOW, resolveWithModel: true, maxModelCalls: 1, invoke });

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result.modelCalls).toBe(1);
    expect(result.modelVerdicts).toBe(10);
    // The two the budget cut off are not lost — they take the unsure default.
    expect(result.defaulted).toBe(2);
    expect(result.coverage).toBe(1);
  });

  it("reads the opt-in from app_state so the user needs no rebuild", async () => {
    fixture();
    appStateSet(TIER_MODEL_KEY, "1");
    const invoke = vi.fn<(c: readonly Ti1Channel[]) => Promise<Ti1Verdict[]>>(async () => []);

    const result = await ensureTiers({ now: NOW, invoke });

    expect(invoke).toHaveBeenCalledTimes(1);
    // The model answered nothing; the channel still ends up tiered (unsure -> tx).
    expect(result.defaulted).toBe(1);
    expect(result.coverage).toBe(1);
  });

  it("takes the unsure default when the transport throws — an outage costs accuracy, not coverage", async () => {
    const { ids, mixed } = fixture();
    const invoke = vi.fn<(c: readonly Ti1Channel[]) => Promise<Ti1Verdict[]>>(async () => {
      throw new Error("claude CLI is not installed");
    });

    const result = await ensureTiers({ now: NOW, resolveWithModel: true, invoke });

    expect(result.ok).toBe(true);
    expect(result.assigned).toBe(ids.length);
    expect(result.coverage).toBe(1);
    // §12.11: the channel the model could not be asked about is still tiered.
    expect(readTier(mixed)).toBe("T2");
    expect(result.defaulted).toBe(1);
  });
});

describe("a coverage failure is loud, not fatal (§9.3 rule 4)", () => {
  it("reports the unassigned streams instead of throwing out of the boot path", async () => {
    const { ids } = fixture();
    // A stream that arrives DURING the pass — the real shape of the failure,
    // and the one the assertion exists to catch. A trigger inserts it after the
    // last tier is written, so the loop never saw it and the assertion does.
    getDb().exec(
      `CREATE TRIGGER ghost_stream AFTER UPDATE OF tier ON streams
         WHEN NEW.id = '${ids[ids.length - 1]}'
       BEGIN
         INSERT INTO streams (id, source_id, external_key)
         VALUES ('ghost', '${SOURCE}', 'ghost@x');
       END;`,
    );

    const result = await ensureTiers({ now: NOW, reason: "boot" });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.unassigned).toEqual(["ghost"]);
    expect(result.assigned).toBe(ids.length);
    expect(result.coverage).toBeLessThan(1);
    // Everything it did manage to tier stayed tiered.
    for (const id of ids) expect(readTier(id)).not.toBeNull();
  });
});
