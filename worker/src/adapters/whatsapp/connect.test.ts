// ===========================================================================
// CNS-09 — the card is honest (V6 P1 S1.5, Build §4.2; GoldenEvals_V6_Phase1
// §5.2), the WhatsApp half, as deterministic vitest — the way S1.2 shipped
// CNS-01..04. Fixture id in the describe title, the doc's Expected line
// asserted by code, ZERO model calls (SQLite on a temp file).
//
//   Expected. Events exact — the card's numbers are the daemon's MEASURED
//             per-window counts (rangefilter.CountByRange, proven equal to an
//             import's emission in Go: TestMockCountRangeEqualsImportEmission);
//             here describeWindows passes them through untouched and labels
//             their accuracy from the sync types actually seen.
//             Card text stored verbatim in `decisions` — confirmWhatsAppWindows
//             writes it byte-for-byte and the consent row points at that row.
//   Wrong.    concurrency-8-time — the card's `days` for "all" is the span of
//             history actually received, never a nominal 5y, so a serial
//             days × 8.2 s estimate built on it describes the real run (the
//             estimate itself is S1.8's card).
//
// Plus the window rules the confirm enforces: Understand never exceeds Index
// (CNS-03 at the API edge), nothing written on a rejected choice.
// ===========================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, runMigrations } from "../../db/connection.js";
import { getConsent } from "../../db/v6core.js";
import { RANGES, type Range, type RangeCounts } from "../types.js";
import {
  confirmWhatsAppWindows,
  countsCaveats,
  describeWindows,
  parseWindowChoice,
  WindowChoiceError,
  windowFloors,
  WINDOW_DAYS,
} from "./connect.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-01T12:00:00.000Z");

function entry(chats: number, messages: number): { chats: number; messages: number } {
  return { chats, messages };
}

/** A measured frame the way the daemon answers count_range after a bulk sync. */
function measured(overrides: Partial<RangeCounts> = {}): RangeCounts {
  const counts = {} as Record<Range, { chats: number; messages: number }>;
  const table: Record<Range, [number, number]> = {
    "24h": [3, 41],
    "3d": [5, 120],
    "7d": [12, 1597],
    "30d": [40, 6091],
    "90d": [80, 8131],
    "180d": [120, 15000],
    "1y": [180, 26000],
    "2y": [214, 38412],
    "3y": [214, 38412],
    "4y": [214, 38412],
    "5y": [214, 38412],
    all: [214, 38412],
  };
  for (const r of RANGES) counts[r] = entry(...table[r]);
  return {
    counts,
    chats: 214,
    messages: 38412,
    oldestTs: new Date(NOW - 400 * DAY).toISOString(),
    newestTs: new Date(NOW - 3_600_000).toISOString(),
    bufferedBatches: 4,
    batches: 4,
    syncTypes: ["FULL", "INITIAL_BOOTSTRAP"],
    rangeInstalled: false,
    pendingLive: 0,
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wa-connect-"));
  process.env.SUPERTWIN_DB_PATH = join(tmpDir, "test.db");
  process.env.SUPERTWIN_HOME = tmpDir;
  closeDb();
  runMigrations();
});

afterEach(() => {
  closeDb();
  delete process.env.SUPERTWIN_DB_PATH;
  delete process.env.SUPERTWIN_HOME;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("CNS-09 — the card is honest (WhatsApp connect: measured counts, verbatim card)", () => {
  it("events exact: the card rows are the daemon's measured counts, untouched, labelled measured", () => {
    const frame = measured();
    const rows = describeWindows(frame, NOW);
    expect(rows.map((r) => r.range)).toEqual([...RANGES]);
    for (const row of rows) {
      expect(row.messages).toBe(frame.counts[row.range].messages);
      expect(row.chats).toBe(frame.counts[row.range].chats);
      expect(row.accuracy).toBe("measured");
    }
    // Days: nominal per window, capped at the span of history actually
    // received (400 days here) — 5y over 400 days of history is 400 days.
    const byRange = new Map(rows.map((r) => [r.range, r]));
    expect(byRange.get("7d")!.days).toBe(7);
    expect(byRange.get("1y")!.days).toBe(365);
    expect(byRange.get("2y")!.days).toBe(400);
    expect(byRange.get("5y")!.days).toBe(400);
    expect(byRange.get("all")!.days).toBe(400);
    for (const r of RANGES) {
      if (r === "all") continue;
      expect(byRange.get(r)!.days).toBeLessThanOrEqual(WINDOW_DAYS[r]);
    }
  });

  it("bootstrap-only counts are labelled so-far and the caveat says they will rise", () => {
    const frame = measured({ syncTypes: ["INITIAL_BOOTSTRAP"], batches: 1, bufferedBatches: 1 });
    for (const row of describeWindows(frame, NOW)) expect(row.accuracy).toBe("so-far");
    const caveats = countsCaveats(frame, NOW);
    expect(caveats.some((c) => /bootstrap batch so far/.test(c))).toBe(true);
    expect(caveats.some((c) => /reaches back to 2025-07-28/.test(c))).toBe(true);
    // A bulk sync removes the bootstrap caveat but keeps the reach line.
    const bulk = countsCaveats(measured(), NOW);
    expect(bulk.some((c) => /bootstrap/.test(c))).toBe(false);
    expect(bulk.some((c) => /Everything.*means everything WhatsApp has sent/.test(c))).toBe(true);
  });

  it("nothing received yet → accuracy none, days 0 for all, and the keep-the-phone-online caveat", () => {
    const empty = measured({
      batches: 0,
      bufferedBatches: 0,
      syncTypes: [],
      chats: 0,
      messages: 0,
      oldestTs: undefined,
      newestTs: undefined,
      counts: Object.fromEntries(RANGES.map((r) => [r, entry(0, 0)])) as RangeCounts["counts"],
    });
    const rows = describeWindows(empty, NOW);
    for (const row of rows) expect(row.accuracy).toBe("none");
    expect(rows.find((r) => r.range === "all")!.days).toBe(0);
    expect(rows.find((r) => r.range === "30d")!.days).toBe(30);
    expect(countsCaveats(empty, NOW)[0]).toMatch(/hasn't sent any history yet/);
  });

  it("held live messages are disclosed on the card", () => {
    expect(countsCaveats(measured({ pendingLive: 1 }), NOW)).toContainEqual(
      expect.stringMatching(/^1 message arrived since pairing and is held until you confirm/),
    );
    expect(countsCaveats(measured({ pendingLive: 7 }), NOW)).toContainEqual(
      expect.stringMatching(/^7 messages arrived since pairing and are held/),
    );
  });

  it("card text stored verbatim in decisions; the consent row points at it", () => {
    const frame = measured();
    const cardText = [
      "Index everything WhatsApp will give: 38,412 messages in 214 chats over 400 days (measured).",
      "Understand last 30 days: 6,091 messages over 30 days (measured).",
      "  — with “smart quotes”, a trailing space, and\ta tab ",
      ...countsCaveats(frame, NOW),
    ].join("\n");

    const result = confirmWhatsAppWindows({
      index: "all",
      understand: "30d",
      cardText,
      counts: frame,
      nowMs: NOW,
    });

    // The consent row: connected, Index everything, Understand 30 d from NOW.
    const consent = getConsent("whatsapp");
    expect(consent).not.toBeNull();
    expect(consent!.id).toBe(result.consent.id);
    expect(consent!.state).toBe("connected");
    expect(consent!.indexAll).toBe(true);
    expect(consent!.indexFrom).toBeNull();
    expect(consent!.understandFrom).toBe(new Date(NOW - 30 * DAY).toISOString());
    expect(consent!.decisionId).toBe(result.decisionId);

    // The decisions row: card text byte-for-byte, in reason AND new_json.card_text.
    const row = getDb()
      .prepare(`SELECT pass, target_kind, target_id, action, reason, new_json FROM decisions WHERE id = ?`)
      .get(result.decisionId) as {
      pass: string;
      target_kind: string;
      target_id: string;
      action: string;
      reason: string;
      new_json: string;
    };
    expect(row.pass).toBe("user");
    expect(row.target_kind).toBe("consent");
    expect(row.target_id).toBe("whatsapp");
    expect(row.action).toBe("grant");
    expect(row.reason).toBe(cardText);
    const stored = JSON.parse(row.new_json) as {
      card_text: string;
      index: string;
      understand: string | null;
      counts: RangeCounts;
      understand_from: string;
    };
    expect(stored.card_text).toBe(cardText);
    expect(stored.index).toBe("all");
    expect(stored.understand).toBe("30d");
    expect(stored.counts.counts["30d"]).toEqual(entry(40, 6091));
    expect(stored.understand_from).toBe(consent!.understandFrom);
  });

  it("a bounded Index gets a real floor; Understand null means nothing goes to the model", () => {
    const result = confirmWhatsAppWindows({ index: "90d", understand: null, cardText: "x", nowMs: NOW });
    expect(result.consent.indexAll).toBe(false);
    expect(result.consent.indexFrom).toBe(new Date(NOW - 90 * DAY).toISOString());
    expect(result.consent.understandFrom).toBeNull();
    expect(windowFloors({ index: "7d", understand: "all" }, NOW).understandFrom).toBe(
      new Date(0).toISOString(),
    );
  });

  it("re-confirming supersedes the earlier consent row and records a second decision", () => {
    const first = confirmWhatsAppWindows({ index: "30d", understand: "7d", cardText: "first", nowMs: NOW });
    const second = confirmWhatsAppWindows({ index: "all", understand: "30d", cardText: "second", nowMs: NOW + 1 });
    expect(second.decisionId).not.toBe(first.decisionId);
    const live = getConsent("whatsapp")!;
    expect(live.id).toBe(second.consent.id);
    expect(live.decisionId).toBe(second.decisionId);
    const n = getDb().prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind = 'consent'`).get() as { n: number };
    expect(n.n).toBe(2);
    const revoked = getDb()
      .prepare(`SELECT state, revoked_at FROM consents WHERE id = ?`)
      .get(first.consent.id) as { state: string; revoked_at: string | null };
    expect(revoked.state).toBe("revoked");
    expect(revoked.revoked_at).not.toBeNull();
  });
});

describe("window rules at the confirm edge (Understand never exceeds Index — CNS-03)", () => {
  it("defaults: Index everything, Understand 30 d", () => {
    expect(parseWindowChoice({})).toEqual({ index: "all", understand: "30d" });
  });

  it("rejects Understand wider than Index, unknown ranges, and writes nothing", () => {
    expect(() => parseWindowChoice({ index: "30d", understand: "90d" })).toThrow(WindowChoiceError);
    expect(() => parseWindowChoice({ index: "bogus" })).toThrow(WindowChoiceError);
    expect(() => parseWindowChoice({ index: "7d", understand: 7 })).toThrow(WindowChoiceError);
    expect(() =>
      confirmWhatsAppWindows({ index: "30d", understand: "1y", cardText: "never stored", nowMs: NOW }),
    ).toThrow(WindowChoiceError);
    expect(getConsent("whatsapp")).toBeNull();
    const n = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM decisions WHERE target_kind <> 'provider_rollout'`)
      .get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("accepts Understand equal to Index and Understand null", () => {
    expect(parseWindowChoice({ index: "7d", understand: "7d" })).toEqual({ index: "7d", understand: "7d" });
    expect(parseWindowChoice({ index: "24h", understand: null })).toEqual({ index: "24h", understand: null });
  });
});
