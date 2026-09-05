// ===========================================================================
// Structured retrieval (V6 P1 S2.5) — RET-07 as vitest, plus the other four
// shapes the method answers (count, range, status filter, enumerate by type).
//
//   RET-07  Three Uber receipts with `amount` typed; "how much on cabs last
//           month" → structured method, ₹1,020 exact. Wrong mode `topk-sum`:
//           a sum over a truncated candidate list. Asserted two ways — the
//           value is computed over 300 rows with a citation cap of 5, and the
//           planner reads the question into a SUM, never a ranked search.
//
// Zero model calls: pure SQLite on a temp file. TZ pinned so "last month"
// means the same calendar month here as on the user's Mac.
// ===========================================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TZ = "Asia/Kolkata";
const tmpRoot = mkdtempSync(join(tmpdir(), "st-structured-"));
process.env.SUPERTWIN_HOME = join(tmpRoot, "home");
process.env.SUPERTWIN_DB_PATH = join(tmpRoot, "test.db");
process.env.SUPERTWIN_BRAIN_DIR = join(tmpRoot, "brain");

const { closeDb, getDb, runMigrations } = await import("../db/connection.js");
const { setClaimTypedFields, SELF_ENTITY_ID } = await import("../db/v6graph.js");
const { writeClaimVersion, closeClaimVersion } = await import("../claims/store.js");
const {
  DEFAULT_CITATION_ROWS,
  lastMonthRange,
  planStructured,
  resolvePeriod,
  structuredForQuery,
  structuredQuery,
} = await import("./structured.js");

// Golden-evals clock: Sat 2026-09-05 10:00 IST. "Last month" is August 2026.
const NOW = new Date("2026-09-05T04:30:00.000Z");

let seq = 0;
interface Receipt {
  merchant?: string | null;
  amount?: number | null;
  currency?: string | null;
  date?: string | null;
  status?: string | null;
  orderId?: string | null;
  kind?: "fact" | "preference" | "habit";
  subjectId?: string | null;
  text?: string;
}

/** A receipt claim: one version with evidence, typed fields on the header. */
function receipt(r: Receipt): string {
  seq += 1;
  const key = `claim_${seq}`;
  const text = r.text ?? `Paid ₹${r.amount ?? "?"} to ${r.merchant ?? "someone"}`;
  writeClaimVersion({
    claimKey: key,
    kind: r.kind ?? "fact",
    subjectId: r.subjectId === undefined ? SELF_ENTITY_ID : r.subjectId,
    text,
    confidence: 0.95,
    statedAt: r.date ? `${r.date}T10:00:00.000Z` : "2026-08-10T10:00:00.000Z",
    evidence: [{ event_ids: [`ev_${seq}`], quote: text }],
    decidedBy: "test",
  });
  setClaimTypedFields(key, {
    ...(r.merchant !== undefined ? { merchant: r.merchant } : {}),
    ...(r.amount !== undefined ? { amount: r.amount } : {}),
    ...(r.currency !== undefined ? { currency: r.currency } : {}),
    ...(r.date !== undefined ? { date: r.date } : {}),
    ...(r.status !== undefined ? { status: r.status } : {}),
    ...(r.orderId !== undefined ? { order_id: r.orderId } : {}),
  });
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
  getDb().exec(`DELETE FROM claims; DELETE FROM claim_versions; DELETE FROM decisions;`);
  seq = 0;
});

// ---------------------------------------------------------------------------

describe("RET-07 — structured sum", () => {
  it("three Uber receipts → ₹1,020 exact through the structured method", () => {
    receipt({ merchant: "Uber", amount: 340, currency: "INR", date: "2026-08-03" });
    receipt({ merchant: "Uber", amount: 280, currency: "INR", date: "2026-08-14" });
    receipt({ merchant: "Uber", amount: 400, currency: "INR", date: "2026-08-27" });
    // Noise the sum must not touch: a Swiggy order in the same month, an Uber
    // ride in September, a July ride, and a Uber ride with no readable amount.
    receipt({ merchant: "Swiggy", amount: 560, currency: "INR", date: "2026-08-12" });
    receipt({ merchant: "Uber", amount: 199, currency: "INR", date: "2026-09-02" });
    receipt({ merchant: "Uber", amount: 250, currency: "INR", date: "2026-07-30" });
    receipt({ merchant: "Uber", amount: null, currency: "INR", date: "2026-08-20", text: "Uber receipt, amount unreadable" });

    const r = structuredForQuery("how much on cabs last month", NOW);
    expect(r).not.toBeNull();
    expect(r!.method).toBe("structured");
    expect(r!.op).toBe("sum");
    expect(r!.field).toBe("amount");
    expect(r!.value).toBe(1020);
    expect(r!.byCurrency).toEqual([{ currency: "INR", value: 1020, rows: 3 }]);
    expect(r!.rowCount).toBe(3);
    expect(r!.complete).toBe(true);
    expect(r!.rowsTruncated).toBe(false);
    // The unreadable receipt is excluded and COUNTED, never guessed at.
    expect(r!.excluded.untyped).toBe(1);
    // Every contributing row is cited by claim_key.
    expect(r!.rows.map((row) => row.claimKey).sort()).toEqual(["claim_1", "claim_2", "claim_3"]);
    expect(r!.filters.dateFrom).toBe("2026-08-01");
    expect(r!.filters.dateTo).toBe("2026-08-31");
    expect(r!.filters.merchant).toContain("uber");
  });

  it("wrong mode `topk-sum`: the value is over every row, the citation cap only trims `rows`", () => {
    // 300 rides of ₹10 — more than any top-k a ranker would hand back.
    for (let i = 0; i < 300; i++) {
      receipt({ merchant: i % 2 === 0 ? "Uber" : "Ola", amount: 10, currency: "INR", date: `2026-08-${String(1 + (i % 28)).padStart(2, "0")}` });
    }
    const month = lastMonthRange(NOW);
    const r = structuredQuery({ op: "sum", field: "amount", filters: { merchant: ["uber", "ola"], dateFrom: month.fromIso, dateTo: month.toIso }, limit: 5 });
    expect(r.value).toBe(3000);
    expect(r.rowCount).toBe(300);
    expect(r.rows).toHaveLength(5);
    expect(r.rowsTruncated).toBe(true);
    // The default citation cap is small; the value does not shrink with it.
    const dflt = structuredQuery({ op: "sum", filters: { merchant: ["uber", "ola"] } });
    expect(dflt.rows).toHaveLength(DEFAULT_CITATION_ROWS);
    expect(dflt.value).toBe(3000);
  });

  it("the planner reads the question into a SUM — merchants of the category, last calendar month", () => {
    const plan = planStructured("how much on cabs last month", NOW);
    expect(plan).not.toBeNull();
    expect(plan!.query.op).toBe("sum");
    expect(plan!.query.field).toBe("amount");
    expect(plan!.query.filters?.merchant).toEqual(expect.arrayContaining(["uber", "ola"]));
    expect(plan!.query.filters?.dateFrom).toBe("2026-08-01");
    expect(plan!.query.filters?.dateTo).toBe("2026-08-31");
    // Paraphrases plan the same query.
    for (const q of ["total spent on uber last month", "what did I spend on taxis last month", "how much did cabs cost last month"]) {
      const p = planStructured(q, NOW);
      expect(p?.query.op, q).toBe("sum");
      expect(p?.query.filters?.dateFrom, q).toBe("2026-08-01");
    }
    // A question with nothing typed to answer stays out of this method.
    expect(planStructured("did I confirm the villa", NOW)).toBeNull();
    expect(planStructured("what happened tuesday afternoon", NOW)).toBeNull();
  });

  it("mixed currencies never add up: value null, per-currency sums exact", () => {
    receipt({ merchant: "Uber", amount: 340, currency: "INR", date: "2026-08-03" });
    receipt({ merchant: "Uber", amount: 12.5, currency: "USD", date: "2026-08-04" });
    const r = structuredQuery({ op: "sum", filters: { merchant: "uber" } });
    expect(r.value).toBeNull();
    expect(r.byCurrency).toEqual(
      expect.arrayContaining([
        { currency: "INR", value: 340, rows: 1 },
        { currency: "USD", value: 12.5, rows: 1 },
      ]),
    );
    expect(structuredQuery({ op: "sum", filters: { merchant: "uber", currency: "inr" } }).value).toBe(340);
  });

  it("a date filter reports the rows it could not test for lack of a date", () => {
    receipt({ merchant: "Uber", amount: 100, currency: "INR", date: "2026-08-03" });
    receipt({ merchant: "Uber", amount: 100, currency: "INR", date: null });
    const r = structuredQuery({ op: "sum", filters: { merchant: "uber", dateFrom: "2026-08-01", dateTo: "2026-08-31" } });
    expect(r.value).toBe(100);
    expect(r.excluded.undated).toBe(1);
    // Without the date filter both count.
    expect(structuredQuery({ op: "sum", filters: { merchant: "uber" } }).value).toBe(200);
  });

  it("closed claims are history: only active headers count", () => {
    const key = receipt({ merchant: "Uber", amount: 500, currency: "INR", date: "2026-08-03" });
    receipt({ merchant: "Uber", amount: 100, currency: "INR", date: "2026-08-04" });
    const version = getDb().prepare(`SELECT active_version_id AS id FROM claims WHERE claim_key = ?`).get(key) as { id: string };
    closeClaimVersion(version.id, { closedBy: "user", reason: "not mine" });
    const r = structuredQuery({ op: "sum", filters: { merchant: "uber" } });
    expect(r.value).toBe(100);
    expect(r.rowCount).toBe(1);
  });
});

describe("count, range, status filter, enumerate by type", () => {
  it("count: how many orders, exact, with a status filter", () => {
    receipt({ merchant: "Amazon", amount: 999, currency: "INR", date: "2026-08-03", status: "delivered", orderId: "403-1" });
    receipt({ merchant: "Amazon", amount: 1299, currency: "INR", date: "2026-08-09", status: "pending", orderId: "403-2" });
    receipt({ merchant: "Amazon", amount: 450, currency: "INR", date: "2026-08-21", status: "pending", orderId: "403-3" });
    receipt({ merchant: "Flipkart", amount: 200, currency: "INR", date: "2026-08-22", status: "cancelled", orderId: "OD-1" });

    const all = structuredQuery({ op: "count", filters: { hasOrderId: true } });
    expect(all.value).toBe(4);
    const pending = structuredQuery({ op: "count", filters: { status: "Pending" } });
    expect(pending.value).toBe(2);
    expect(pending.rows.map((r) => r.orderId).sort()).toEqual(["403-2", "403-3"]);

    const planned = structuredForQuery("how many amazon orders are pending", NOW);
    expect(planned?.op).toBe("count");
    expect(planned?.value).toBe(2);
    expect(planned?.filters.status).toEqual(["pending"]);
  });

  it("range: earliest and latest date, min and max amount", () => {
    receipt({ merchant: "Uber", amount: 340, currency: "INR", date: "2026-08-03" });
    receipt({ merchant: "Uber", amount: 90, currency: "INR", date: "2026-06-11" });
    receipt({ merchant: "Uber", amount: 1200, currency: "INR", date: "2026-08-27" });
    receipt({ merchant: "Uber", amount: 50, currency: "INR", date: null });

    const dates = structuredQuery({ op: "range", field: "date", filters: { merchant: "uber" } });
    expect(dates.range).toEqual({ min: "2026-06-11", max: "2026-08-27" });
    expect(dates.rowCount).toBe(3);
    expect(dates.excluded.untyped).toBe(1);
    // Citation rows come back in field order.
    expect(dates.rows.map((r) => r.date)).toEqual(["2026-06-11", "2026-08-03", "2026-08-27"]);

    const amounts = structuredQuery({ op: "range", field: "amount", filters: { merchant: "uber" } });
    expect(amounts.range).toEqual({ min: 50, max: 1200 });
    expect(amounts.rowCount).toBe(4);

    expect(structuredQuery({ op: "range", field: "date", filters: { merchant: "nobody" } }).range).toBeNull();
    expect(planStructured("when did I first take an uber", NOW)?.query.op).toBe("range");
  });

  it("list: enumerate by type, newest first, `complete` false when the cap hits", () => {
    for (let i = 0; i < 15; i++) {
      receipt({ kind: "preference", merchant: null, amount: null, date: `2026-08-${String(1 + i).padStart(2, "0")}`, text: `Prefers thing ${i}` });
    }
    receipt({ kind: "habit", text: "Runs on Sundays", date: "2026-08-30" });

    const prefs = structuredQuery({ op: "list", filters: { kind: "preference" } });
    expect(prefs.rowCount).toBe(15);
    expect(prefs.rows).toHaveLength(15);
    expect(prefs.complete).toBe(true);
    expect(prefs.rows[0].text).toBe("Prefers thing 14"); // newest first
    expect(prefs.rows.every((r) => r.kind === "preference")).toBe(true);

    const capped = structuredQuery({ op: "list", filters: { kind: "preference" }, limit: 12 });
    expect(capped.rows).toHaveLength(12);
    expect(capped.rowCount).toBe(15); // "12 so far, list may be incomplete" (BAR-06)
    expect(capped.complete).toBe(false);
    expect(capped.rowsTruncated).toBe(true);

    const planned = structuredForQuery("list all my preferences", NOW);
    expect(planned?.op).toBe("list");
    expect(planned?.rowCount).toBe(15);
    // A typed filter with no verb still enumerates.
    expect(planStructured("uber receipts", NOW)?.query.op).toBe("list");
  });

  it("enumerate by merchant and by subject", () => {
    receipt({ merchant: "Uber", amount: 100, date: "2026-08-01" });
    receipt({ merchant: "Ola", amount: 100, date: "2026-08-02" });
    receipt({ merchant: "Uber", amount: 100, date: "2026-08-03", subjectId: null, text: "Rohan paid the Uber" });
    const uber = structuredQuery({ op: "list", filters: { merchant: "UBER" } });
    expect(uber.rowCount).toBe(2);
    const mine = structuredQuery({ op: "list", filters: { merchant: "uber", subjectId: SELF_ENTITY_ID } });
    expect(mine.rowCount).toBe(1);
  });

  it("rejects a malformed date bound instead of matching nothing silently", () => {
    expect(() => structuredQuery({ op: "count", filters: { dateFrom: "Aug 2026" } })).toThrow(/YYYY-MM-DD/);
    expect(() => structuredQuery({ op: "sum", field: "date" as never })).toThrow(/not numeric/);
  });
});

describe("periods", () => {
  it("resolves calendar periods in the user's local calendar", () => {
    expect(lastMonthRange(NOW)).toEqual({ fromIso: "2026-08-01", toIso: "2026-08-31" });
    expect(lastMonthRange(new Date("2026-01-15T00:00:00+05:30"))).toEqual({ fromIso: "2025-12-01", toIso: "2025-12-31" });
    expect(resolvePeriod("spend this month", NOW)?.range).toEqual({ fromIso: "2026-09-01", toIso: "2026-09-30" });
    expect(resolvePeriod("cabs in july", NOW)?.range).toEqual({ fromIso: "2026-07-01", toIso: "2026-07-31" });
    // A month later than this one, with no year, is last year's.
    expect(resolvePeriod("flights in december", NOW)?.range).toEqual({ fromIso: "2025-12-01", toIso: "2025-12-31" });
    expect(resolvePeriod("hotels in feb 2025", NOW)?.range).toEqual({ fromIso: "2025-02-01", toIso: "2025-02-28" });
    expect(resolvePeriod("last year", NOW)?.range).toEqual({ fromIso: "2025-01-01", toIso: "2025-12-31" });
    // Weeks and days come from dates.ts. Sat 2026-09-05: last week is Mon 08-24 .. Sun 08-30.
    expect(resolvePeriod("spent last week", NOW)?.range).toEqual({ fromIso: "2026-08-24", toIso: "2026-08-30" });
    expect(resolvePeriod("spent yesterday", NOW)?.range).toEqual({ fromIso: "2026-09-04", toIso: "2026-09-04" });
    expect(resolvePeriod("how much on cabs", NOW)).toBeNull();
  });
});
