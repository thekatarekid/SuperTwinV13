// ===========================================================================
// Structured retrieval — V6 P1 S2.5 (Build §5.2, Product_V6 §23.4 method 3,
// §11.14 typed fields; backlog retrieval decision record item 2).
//
// "No top-k of chunks is a sum, and no ranking proves an absence." Questions
// shaped how much · how many · list all · which are pending are answered by
// SQL over the typed-field COLUMNS on `claims` (0201_v6_graph: amount,
// currency, date, typed_status, merchant, order_id, location, duration_s) —
// never by summing whatever a similarity search happened to return.
//
//   sum    SUM(field) over EVERY matching claim, grouped by currency. Exact.
//          A truncated candidate list is the wrong mode RET-07 names
//          (`topk-sum`): the aggregate here is computed in SQL with no LIMIT;
//          only the rows returned FOR CITATION are capped, and that cap is
//          reported as `rowsTruncated`, never folded into the value.
//   count  COUNT(*) over the same predicate.
//   range  MIN/MAX of a numeric field or of `date` — "when did I first/last".
//   list   enumeration by type (kind · merchant · status · subject), ordered
//          by date, capped at `limit`, with `complete` false when the cap hit
//          so the answer can say "12 so far, list may be incomplete" (BAR-06).
//
// Only ACTIVE claim headers count (`claims.status = 'active'` — the claim's
// own lifecycle; a closed claim is history). A claim whose typed field is
// NULL is not guessed at: it is excluded and COUNTED in `excluded` so the
// caller can caveat ("3 receipts, one had no amount I could read").
//
// `planStructured()` is the T0 code-side reading of a question into one of
// these queries — a small, deterministic heuristic that the T1 router (S4)
// replaces with a model plan when the bar escalates. It exists so RET-07 runs
// end to end with zero model calls and so the packer can route an obvious
// aggregate without a call.
//
// Zero model calls. Never writes. Cites by claim_key.
// ===========================================================================

import type { ClaimKind } from "../claims/store.js";
import { getDb } from "../db/connection.js";
import { isoDate, localToday, resolveDates, type DateRange } from "./dates.js";

// ---- Query shape ------------------------------------------------------------

export type StructuredOp = "sum" | "count" | "range" | "list";
export type NumericField = "amount" | "duration_s";
export type RangeField = NumericField | "date";

export interface StructuredFilters {
  /** Case-insensitive match on `merchant`; several = any of. */
  merchant?: string | readonly string[];
  /** Case-insensitive match on the fact's `typed_status`; several = any of. */
  status?: string | readonly string[];
  /** ISO 4217, case-insensitive. */
  currency?: string;
  kind?: ClaimKind | readonly ClaimKind[];
  subjectId?: string;
  /** Inclusive YYYY-MM-DD bounds on the fact's `date`. */
  dateFrom?: string;
  dateTo?: string;
  /** Only claims that carry (or lack) an order / booking reference. */
  hasOrderId?: boolean;
  /** Case-insensitive substring on `location`. */
  location?: string;
}

export interface StructuredQuery {
  op: StructuredOp;
  /** sum → amount|duration_s (default amount); range → amount|duration_s|date. */
  field?: RangeField;
  filters?: StructuredFilters;
  /** list: rows returned (default 200, max 5,000). sum/count: rows returned for citation only. */
  limit?: number;
}

// ---- Result shape -----------------------------------------------------------

export interface StructuredRow {
  claimKey: string;
  kind: string | null;
  subjectId: string | null;
  /** The active version's text, or null when the header has no live version. */
  text: string | null;
  statedAt: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  status: string | null;
  merchant: string | null;
  orderId: string | null;
  location: string | null;
  durationS: number | null;
}

export interface CurrencySum {
  /** null when the rows carried no currency. */
  currency: string | null;
  value: number;
  rows: number;
}

export interface StructuredResult {
  method: "structured";
  op: StructuredOp;
  field: RangeField | null;
  filters: StructuredFilters;
  /**
   * sum: the total when every contributing row shares one currency (or the
   * field is not money); null when currencies are mixed — see `byCurrency`.
   * count: the count. range/list: null.
   */
  value: number | null;
  /** sum only: one entry per currency, exact. */
  byCurrency: CurrencySum[];
  /** range only. Numeric for amount/duration_s, YYYY-MM-DD strings for date. */
  range: { min: number | string; max: number | string } | null;
  /** Rows the value rests on (sum/count/range: for citation; list: the enumeration). */
  rows: StructuredRow[];
  /** Matching rows in total, before any cap. */
  rowCount: number;
  /** list: false when `limit` cut the enumeration. Always true for aggregates. */
  complete: boolean;
  /** sum/count/range: `rows` is a citation sample, the value is over all `rowCount`. */
  rowsTruncated: boolean;
  /** Matching-by-filter rows left out because a needed typed field was NULL. */
  excluded: { untyped: number; undated: number };
  /** The predicate that ran (diagnostics). */
  sql: string;
}

export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 5_000;
/** Citation rows returned with an aggregate. The VALUE never depends on this. */
export const DEFAULT_CITATION_ROWS = 50;

// ---- Predicate --------------------------------------------------------------

interface Predicate {
  where: string;
  params: unknown[];
}

function listOf(v: string | readonly string[] | undefined): string[] {
  if (v === undefined) return [];
  const arr = typeof v === "string" ? [v] : [...v];
  return [...new Set(arr.map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0))];
}

function assertIsoDay(label: string, s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`structured: ${label} must be YYYY-MM-DD, got ${JSON.stringify(s)}`);
  return s;
}

/**
 * The filter predicate, WITHOUT the typed-field-present clause — that one is
 * added per op so the excluded (NULL) rows can be counted separately.
 */
function buildPredicate(f: StructuredFilters): Predicate {
  const where: string[] = ["c.status = 'active'"];
  const params: unknown[] = [];

  const merchants = listOf(f.merchant);
  if (merchants.length > 0) {
    where.push(`LOWER(c.merchant) IN (${merchants.map(() => "?").join(",")})`);
    params.push(...merchants);
  }
  const statuses = listOf(f.status);
  if (statuses.length > 0) {
    where.push(`LOWER(c.typed_status) IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (f.currency) {
    where.push("UPPER(c.currency) = ?");
    params.push(f.currency.trim().toUpperCase());
  }
  const kinds = listOf(f.kind as string | readonly string[] | undefined);
  if (kinds.length > 0) {
    where.push(`c.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (f.subjectId) {
    where.push("c.subject_id = ?");
    params.push(f.subjectId);
  }
  if (f.dateFrom) {
    where.push("c.date >= ?");
    params.push(assertIsoDay("dateFrom", f.dateFrom));
  }
  if (f.dateTo) {
    where.push("c.date <= ?");
    params.push(assertIsoDay("dateTo", f.dateTo));
  }
  if (f.hasOrderId === true) where.push("c.order_id IS NOT NULL");
  if (f.hasOrderId === false) where.push("c.order_id IS NULL");
  if (f.location) {
    where.push("LOWER(c.location) LIKE ?");
    params.push(`%${f.location.trim().toLowerCase()}%`);
  }
  return { where: where.join(" AND "), params };
}

/** Same filters with the date clauses removed — to count what a date filter dropped for lack of a date. */
function withoutDate(f: StructuredFilters): StructuredFilters {
  const { dateFrom: _from, dateTo: _to, ...rest } = f;
  return rest;
}

const ROW_SELECT = /* sql */ `
  SELECT c.claim_key, c.kind, c.subject_id, cv.text, cv.stated_at,
         c.amount, c.currency, c.date, c.typed_status, c.merchant, c.order_id, c.location, c.duration_s
    FROM claims c
    LEFT JOIN claim_versions cv ON cv.id = c.active_version_id`;

interface RawRow {
  claim_key: string; kind: string | null; subject_id: string | null; text: string | null; stated_at: string | null;
  amount: number | null; currency: string | null; date: string | null; typed_status: string | null; merchant: string | null;
  order_id: string | null; location: string | null; duration_s: number | null;
}

function hydrate(r: RawRow): StructuredRow {
  return {
    claimKey: r.claim_key,
    kind: r.kind,
    subjectId: r.subject_id,
    text: r.text,
    statedAt: r.stated_at,
    amount: r.amount,
    currency: r.currency,
    date: r.date,
    status: r.typed_status,
    merchant: r.merchant,
    orderId: r.order_id,
    location: r.location,
    durationS: r.duration_s,
  };
}

function clampLimit(raw: number | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), MAX_LIST_LIMIT);
}

// ---- The method -------------------------------------------------------------

export function structuredQuery(q: StructuredQuery): StructuredResult {
  const db = getDb();
  const filters: StructuredFilters = q.filters ?? {};
  const base = buildPredicate(filters);
  const hasDateFilter = Boolean(filters.dateFrom || filters.dateTo);

  // Rows that match everything but a date filter, and have no date to test.
  let undated = 0;
  if (hasDateFilter) {
    const noDate = buildPredicate(withoutDate(filters));
    undated = (db.prepare(`SELECT COUNT(*) AS n FROM claims c WHERE ${noDate.where} AND c.date IS NULL`).get(...noDate.params) as { n: number }).n;
  }

  const result: StructuredResult = {
    method: "structured",
    op: q.op,
    field: null,
    filters,
    value: null,
    byCurrency: [],
    range: null,
    rows: [],
    rowCount: 0,
    complete: true,
    rowsTruncated: false,
    excluded: { untyped: 0, undated },
    sql: base.where,
  };

  switch (q.op) {
    case "sum": {
      const field: NumericField = q.field === "duration_s" ? "duration_s" : "amount";
      if (q.field && q.field !== field) throw new Error(`structured: sum over ${q.field} is not numeric`);
      result.field = field;
      const where = `${base.where} AND c.${field} IS NOT NULL`;
      result.sql = where;
      // The aggregate: every matching row, no LIMIT anywhere near it.
      const groups = db
        .prepare(
          `SELECT c.currency AS currency, SUM(c.${field}) AS value, COUNT(*) AS rows
             FROM claims c WHERE ${where} GROUP BY c.currency ORDER BY rows DESC, c.currency`,
        )
        .all(...base.params) as { currency: string | null; value: number; rows: number }[];
      result.byCurrency = groups.map((g) => ({ currency: g.currency, value: g.value, rows: g.rows }));
      result.rowCount = groups.reduce((n, g) => n + g.rows, 0);
      if (field === "duration_s") {
        result.value = groups.reduce((n, g) => n + g.value, 0);
      } else if (groups.length === 1) {
        result.value = groups[0].value;
      } else {
        result.value = null; // mixed currencies: never add rupees to dollars
      }
      result.excluded.untyped = (db.prepare(`SELECT COUNT(*) AS n FROM claims c WHERE ${base.where} AND c.${field} IS NULL`).get(...base.params) as { n: number }).n;
      const cap = clampLimit(q.limit, DEFAULT_CITATION_ROWS);
      result.rows = (db.prepare(`${ROW_SELECT} WHERE ${where} ORDER BY c.date DESC, cv.stated_at DESC, c.claim_key LIMIT ?`).all(...base.params, cap) as RawRow[]).map(hydrate);
      result.rowsTruncated = result.rowCount > result.rows.length;
      return result;
    }
    case "count": {
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM claims c WHERE ${base.where}`).get(...base.params) as { n: number }).n;
      result.value = n;
      result.rowCount = n;
      const cap = clampLimit(q.limit, DEFAULT_CITATION_ROWS);
      result.rows = (db.prepare(`${ROW_SELECT} WHERE ${base.where} ORDER BY c.date DESC, cv.stated_at DESC, c.claim_key LIMIT ?`).all(...base.params, cap) as RawRow[]).map(hydrate);
      result.rowsTruncated = n > result.rows.length;
      return result;
    }
    case "range": {
      const field: RangeField = q.field ?? "date";
      if (field !== "amount" && field !== "duration_s" && field !== "date") throw new Error(`structured: range over ${String(field)} is not supported`);
      result.field = field;
      const where = `${base.where} AND c.${field} IS NOT NULL`;
      result.sql = where;
      const agg = db.prepare(`SELECT MIN(c.${field}) AS lo, MAX(c.${field}) AS hi, COUNT(*) AS n FROM claims c WHERE ${where}`).get(...base.params) as {
        lo: number | string | null; hi: number | string | null; n: number;
      };
      result.rowCount = agg.n;
      result.range = agg.n > 0 && agg.lo !== null && agg.hi !== null ? { min: agg.lo, max: agg.hi } : null;
      result.excluded.untyped = (db.prepare(`SELECT COUNT(*) AS n FROM claims c WHERE ${base.where} AND c.${field} IS NULL`).get(...base.params) as { n: number }).n;
      const cap = clampLimit(q.limit, DEFAULT_CITATION_ROWS);
      result.rows = (db.prepare(`${ROW_SELECT} WHERE ${where} ORDER BY c.${field} ASC, c.claim_key LIMIT ?`).all(...base.params, cap) as RawRow[]).map(hydrate);
      result.rowsTruncated = agg.n > result.rows.length;
      return result;
    }
    case "list": {
      const limit = clampLimit(q.limit, DEFAULT_LIST_LIMIT);
      result.rowCount = (db.prepare(`SELECT COUNT(*) AS n FROM claims c WHERE ${base.where}`).get(...base.params) as { n: number }).n;
      result.rows = (db.prepare(`${ROW_SELECT} WHERE ${base.where} ORDER BY COALESCE(c.date, substr(cv.stated_at, 1, 10)) DESC, cv.stated_at DESC, c.claim_key LIMIT ?`).all(...base.params, limit) as RawRow[]).map(hydrate);
      result.complete = result.rowCount <= result.rows.length;
      result.rowsTruncated = !result.complete;
      return result;
    }
    default:
      throw new Error(`structured: unknown op ${String((q as { op: unknown }).op)}`);
  }
}

// ---- Planner (T0, code) ------------------------------------------------------

/**
 * Category words → merchants, so "cabs" reaches the Uber and Ola receipts
 * without anyone typing a merchant name. Merchants are matched
 * case-insensitively against `claims.merchant` as extraction wrote it.
 */
export const MERCHANT_CATEGORIES: Readonly<Record<string, readonly string[]>> = {
  cabs: ["uber", "ola", "rapido", "meru", "blusmart", "namma yatri"],
  food: ["swiggy", "zomato", "dominos", "domino's", "eatsure", "blinkit", "zepto", "instamart"],
  groceries: ["blinkit", "zepto", "instamart", "bigbasket", "dunzo"],
  flights: ["indigo", "air india", "vistara", "akasa", "spicejet", "goibibo", "makemytrip", "cleartrip", "ixigo"],
  hotels: ["airbnb", "oyo", "goibibo", "makemytrip", "booking.com", "agoda", "treebo"],
  shopping: ["amazon", "flipkart", "myntra", "ajio", "nykaa"],
};

/**
 * Words that name a spend category outright. Kept to nouns that only ever
 * mean the category — "villa" is a hotel sometimes and a chat topic always,
 * so it is not here; a question about villas reaches lexical/vector instead.
 */
const CATEGORY_WORDS: ReadonlyMap<string, string> = new Map([
  ["cab", "cabs"], ["cabs", "cabs"], ["taxi", "cabs"], ["taxis", "cabs"], ["rides", "cabs"],
  ["food", "food"], ["takeout", "food"],
  ["grocery", "groceries"], ["groceries", "groceries"],
  ["flight", "flights"], ["flights", "flights"],
  ["hotel", "hotels"], ["hotels", "hotels"],
  ["shopping", "shopping"],
]);

const ALL_MERCHANTS: ReadonlySet<string> = new Set(Object.values(MERCHANT_CATEGORIES).flat());

/** Status words a question can carry, as extraction spells `typed_status`. */
export const STATUS_WORDS: ReadonlySet<string> = new Set([
  "pending", "confirmed", "delivered", "cancelled", "canceled", "refunded", "shipped", "paid", "unpaid", "booked", "failed",
]);

const KIND_WORDS: ReadonlyMap<string, ClaimKind> = new Map([
  ["preference", "preference"], ["preferences", "preference"],
  ["belief", "belief"], ["beliefs", "belief"],
  ["opinion", "opinion"], ["opinions", "opinion"],
  ["interest", "interest"], ["interests", "interest"],
  ["habit", "habit"], ["habits", "habit"],
  ["recommendation", "recommendation"], ["recommendations", "recommendation"],
  ["workflow", "workflow"], ["workflows", "workflow"],
  ["relationship", "relationship"], ["relationships", "relationship"],
  ["fact", "fact"], ["facts", "fact"],
]);

const SUM_RE = /\b(how much|total|spent|spend|spending|paid|cost|costs)\b/;
const COUNT_RE = /\b(how many|count|number of)\b/;
const LIST_RE = /\b(list|show|enumerate|every|all)\b/;
const RANGE_RE = /\b(first|last|earliest|latest|when did|between|range)\b/;
const DURATION_RE = /\b(how long|minutes|hours|duration|time spent)\b/;

const MONTH_INDEX: ReadonlyMap<string, number> = new Map([
  ["jan", 1], ["january", 1], ["feb", 2], ["february", 2], ["mar", 3], ["march", 3], ["apr", 4], ["april", 4], ["may", 5],
  ["jun", 6], ["june", 6], ["jul", 7], ["july", 7], ["aug", 8], ["august", 8], ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10], ["nov", 11], ["november", 11], ["dec", 12], ["december", 12],
]);

function monthRange(year: number, month: number): DateRange {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { fromIso: isoDate({ year, month, day: 1 }), toIso: isoDate({ year, month, day: lastDay }) };
}

/** The previous calendar month, in the user's local calendar. */
export function lastMonthRange(now: Date): DateRange {
  const t = localToday(now);
  const m = t.month === 1 ? 12 : t.month - 1;
  const y = t.month === 1 ? t.year - 1 : t.year;
  return monthRange(y, m);
}

export function thisMonthRange(now: Date): DateRange {
  const t = localToday(now);
  return monthRange(t.year, t.month);
}

/**
 * The date range a question names, or null. Months and years are handled here;
 * days and weeks come from dates.ts so "last week" means the same thing in
 * every method.
 */
export function resolvePeriod(query: string, now: Date): { range: DateRange; expression: string } | null {
  const q = query.toLowerCase();
  const t = localToday(now);
  if (/\blast month\b/.test(q)) return { range: lastMonthRange(now), expression: "last month" };
  if (/\bthis month\b/.test(q)) return { range: thisMonthRange(now), expression: "this month" };
  if (/\blast year\b/.test(q)) return { range: { fromIso: `${t.year - 1}-01-01`, toIso: `${t.year - 1}-12-31` }, expression: "last year" };
  if (/\bthis year\b/.test(q)) return { range: { fromIso: `${t.year}-01-01`, toIso: `${t.year}-12-31` }, expression: "this year" };
  const named = /\b(?:in|during|for)\s+([a-z]+)(?:\s+(\d{4}))?\b/.exec(q);
  if (named) {
    const month = MONTH_INDEX.get(named[1]);
    if (month !== undefined) {
      let year = named[2] ? Number(named[2]) : t.year;
      // A month later than this one, with no year, is last year's.
      if (!named[2] && month > t.month) year -= 1;
      return { range: monthRange(year, month), expression: named[0].trim() };
    }
  }
  const dates = resolveDates(query, now);
  if (dates.ranges.length > 0) {
    // Past-tense questions about a period: the earliest range start to the latest end.
    const past = dates.ranges.filter((r) => r.toIso <= dates.todayIso);
    const pick = past.length > 0 ? past : dates.ranges;
    const fromIso = pick.reduce((a, r) => (r.fromIso < a ? r.fromIso : a), pick[0].fromIso);
    const toIso = pick.reduce((a, r) => (r.toIso > a ? r.toIso : a), pick[0].toIso);
    return { range: { fromIso, toIso }, expression: dates.dates[0]?.expression ?? "date" };
  }
  return null;
}

export interface StructuredPlan {
  query: StructuredQuery;
  /** What in the question produced each part (diagnostics, shown to the model at T1). */
  because: string[];
}

/**
 * Read a question into a structured query, or null when it is not shaped like
 * one (then it is a lexical/vector question and this method stays out).
 *
 * Deterministic on purpose: a sum question must reach SQL even when the
 * router is unavailable, and the same words must plan the same query every
 * time so the wrong mode `topk-sum` cannot creep back in through a paraphrase.
 */
export function planStructured(query: string, now: Date): StructuredPlan | null {
  const q = query.toLowerCase().replace(/[^\p{L}\p{N}'.\s-]+/gu, " ");
  const words = q.split(/\s+/).filter((w) => w.length > 0);
  const because: string[] = [];

  let op: StructuredOp | null = null;
  let field: RangeField | undefined;
  if (DURATION_RE.test(q)) {
    op = "sum";
    field = "duration_s";
    because.push("duration words → sum duration_s");
  } else if (SUM_RE.test(q)) {
    op = "sum";
    field = "amount";
    because.push(`"${SUM_RE.exec(q)![1]}" → sum amount`);
  } else if (COUNT_RE.test(q)) {
    op = "count";
    because.push(`"${COUNT_RE.exec(q)![1]}" → count`);
  } else if (RANGE_RE.test(q) && /\b(when|date|time)\b/.test(q)) {
    op = "range";
    field = "date";
    because.push(`"${RANGE_RE.exec(q)![1]}" → date range`);
  } else if (LIST_RE.test(q)) {
    op = "list";
    because.push(`"${LIST_RE.exec(q)![1]}" → enumerate`);
  }

  const filters: StructuredFilters = {};
  const merchants = new Set<string>();
  for (const w of words) {
    const cat = CATEGORY_WORDS.get(w);
    if (cat) {
      for (const m of MERCHANT_CATEGORIES[cat]) merchants.add(m);
      because.push(`"${w}" → merchants of ${cat}`);
    }
    if (ALL_MERCHANTS.has(w)) {
      merchants.add(w);
      because.push(`"${w}" → merchant`);
    }
  }
  // Two-word merchants ("air india", "namma yatri").
  for (const m of ALL_MERCHANTS) {
    if (m.includes(" ") && q.includes(m)) {
      merchants.add(m);
      because.push(`"${m}" → merchant`);
    }
  }
  if (merchants.size > 0) filters.merchant = [...merchants];

  const statuses = words.filter((w) => STATUS_WORDS.has(w));
  if (statuses.length > 0) {
    filters.status = [...new Set(statuses.map((s) => (s === "canceled" ? "cancelled" : s)))];
    because.push(`status words → ${filters.status.join("|")}`);
  }

  const kinds = [...new Set(words.map((w) => KIND_WORDS.get(w)).filter((k): k is ClaimKind => k !== undefined))];
  if (kinds.length > 0) {
    filters.kind = kinds;
    because.push(`kind words → ${kinds.join("|")}`);
  }

  const period = resolvePeriod(query, now);
  if (period) {
    filters.dateFrom = period.range.fromIso;
    filters.dateTo = period.range.toIso;
    because.push(`"${period.expression}" → ${period.range.fromIso}..${period.range.toIso}`);
  }

  // A filter with no verb is still a question about typed rows ("uber receipts
  // last month") — enumerate. A verb with nothing typed to filter on is not
  // ours unless it is a plain sum/count over money ("how much did I spend").
  const namedMerchant = [...merchants].some((m) => q.includes(m));
  if (!op) {
    if (namedMerchant || statuses.length > 0 || kinds.length > 0) {
      op = "list";
      because.push("typed filter without a verb → enumerate");
    } else {
      return null;
    }
  }
  if (op === "list" && merchants.size === 0 && statuses.length === 0 && kinds.length === 0 && !period) return null;

  return { query: { op, ...(field ? { field } : {}), filters }, because };
}

/** The whole method: plan, and if the question is structured-shaped, run it. */
export function structuredForQuery(query: string, now: Date = new Date()): (StructuredResult & { because: string[] }) | null {
  const plan = planStructured(query, now);
  if (!plan) return null;
  return { ...structuredQuery(plan.query), because: plan.because };
}
