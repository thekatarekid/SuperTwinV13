// ===========================================================================
// [CODE] The confirm card — V6 P1 S1.8 (Build §4.2; backlog T4-10; Product
// P1 §3.4 "Window card: events (exact) · cost, time, disk (about)").
//
// Four numbers, each carrying ITS OWN accuracy label, computed from the two
// windows the user picked and the counts the source flow measured:
//
//   events  exact when the source counted them (S1.4 profile counts, S1.5
//           `messagesInRange`, or the log itself on a re-confirm); "about"
//           when the flow could only estimate; null when nothing can be
//           counted yet — the card then shows a dash, never an invention.
//   cost    understand-days × $0.0104 — ESTIMATE ±40%. The line names the
//           daily ceiling the budget module enforces (providers/budget.ts), so
//           "we'll stop and ask if it passes $15" is a fact about the code,
//           not a promise.
//   time    understand-days × 8.2 s, SERIAL. Never a concurrency-8 number:
//           the pool may run wider, but the number quoted is the one that
//           holds when it does not (CNS-09 wrong mode `concurrency-8-time`).
//   disk    narrow-archive model — indexed events × 1,330 B (log + indexes +
//           FTS, Product_V6 §590) plus understood events × 18.1 KB (derived
//           output + telemetry, backlog Tier 5 header). "about".
//
// No number the code cannot compute at that moment. The rendered text is
// stored VERBATIM in the `decisions` row that `consents.decision_id`
// references (`reason` = the text, `new_json` = the card), so the "why?"
// surface can show exactly what the user agreed to.
//
// Zero model calls. Pure functions plus one transaction in `confirmConsent`.
// ===========================================================================

import { getDb } from "../db/connection.js";
import { setUnderstandWindow, type WindowChange } from "../db/consent-gate.js";
import { writeDecision } from "../db/decisions.js";
import {
  assertWindowsValid,
  getConsent,
  grantConsent,
  setConsentWindows,
  type ConsentRow,
} from "../db/v6core.js";
import { DEFAULT_CEILINGS } from "../providers/budget.js";

// ---- The measured constants (named so the tests pin the model, not a value) ---

/** $ per day of history understood — T4-10. */
export const COST_PER_DAY_USD = 0.0104;
/** Seconds per day of history understood, ONE call after another — T4-10. */
export const SECONDS_PER_DAY_SERIAL = 8.2;
/** Bytes an indexed event costs in the log with indexes + FTS — Product_V6 §590. */
export const BYTES_PER_INDEXED_EVENT = 1_330;
/** Bytes an understood event adds in derived output + telemetry — backlog T5. */
export const BYTES_PER_UNDERSTOOD_EVENT = 18_100;
/** The card schema version stored in `decisions.new_json`. */
export const CONFIRM_CARD_VERSION = "confirm-card.v1";

const DAY_MS = 86_400_000;

export type Accuracy = "exact" | "about" | "estimate ±40%" | "estimate ±30%";

export interface CardNumber {
  /** null = the code cannot compute this right now; the UI shows a dash. */
  value: number | null;
  unit: "events" | "usd" | "seconds" | "bytes";
  accuracy: Accuracy;
  /** The number as the card prints it ("1,204", "about $0.31", "—"). */
  display: string;
  /** One short line under the number, when there is something to say. */
  note: string | null;
}

/** What the source flow measured before confirm. */
export interface CardCounts {
  /** Events inside the INDEX window (null = not countable yet). */
  index: number | null;
  /** Events inside the UNDERSTAND window (null = not countable yet). */
  understand: number | null;
  /** True when both counts came from a real count, not an estimate. */
  exact: boolean;
}

export interface CardInput {
  source: string;
  /** INDEX = everything (default when `indexFrom` is absent). */
  indexAll?: boolean;
  /** INDEX floor, ISO, when `indexAll` is false. */
  indexFrom?: string | null;
  /** UNDERSTAND floor, ISO; null = nothing goes to the model. */
  understandFrom: string | null;
  counts?: CardCounts | null;
  /** The clock the card is computed on (tests pin it). */
  nowMs?: number;
  /** "We'll stop and ask if it passes $X" — defaults to the daily ceiling. */
  stopAskUsd?: number;
}

export interface ConfirmCard {
  version: typeof CONFIRM_CARD_VERSION;
  source: string;
  indexAll: boolean;
  indexFrom: string | null;
  understandFrom: string | null;
  /** Whole days the UNDERSTAND window covers (0 when nothing is understood). */
  understandDays: number;
  /** Whole days the INDEX window covers; null = everything. */
  indexDays: number | null;
  events: CardNumber;
  cost: CardNumber;
  time: CardNumber;
  disk: CardNumber;
  /** The enforced ceiling the cost line names. */
  stopAskUsd: number;
  /** Computed on this clock (ISO). */
  computedAt: string;
  /** The card as text — stored verbatim in `decisions.reason`. */
  text: string;
}

// ---- Helpers ------------------------------------------------------------------

function parseTs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`confirm-card: not an ISO timestamp: ${iso}`);
  return ms;
}

/** Whole days between `fromIso` and `nowMs`, rounded up, never negative. */
export function windowDays(fromIso: string | null, nowMs: number): number {
  if (fromIso === null) return 0;
  const span = nowMs - parseTs(fromIso);
  if (span <= 0) return 0;
  return Math.ceil(span / DAY_MS);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Aug 2026" (UTC) — how the card names a floor. */
export function dayLabel(iso: string): string {
  const d = new Date(parseTs(iso));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "under $0.01";
  return `$${usd.toFixed(2)}`;
}

/** "4 min 6 s" · "1 h 12 min" · "8 s" — never a fraction, never a parallel figure. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return rest > 0 ? `${m} min ${rest} s` : `${m} min`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  whatsapp: "WhatsApp",
  wa: "WhatsApp",
  browser: "Browser",
  screen: "Screen",
  self: "SuperTwin",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

// ---- The card -------------------------------------------------------------------

/**
 * Build the card. Pure over its input: same input, same card, same text.
 * Throws ConsentWindowError when Understand reaches further back than Index
 * (CNS-03) — a card for an invalid pair of windows must never render.
 */
export function buildConfirmCard(input: CardInput): ConfirmCard {
  const nowMs = input.nowMs ?? Date.now();
  const indexAll = input.indexAll ?? input.indexFrom == null;
  const indexFrom = indexAll ? null : (input.indexFrom ?? null);
  const understandFrom = input.understandFrom ?? null;
  assertWindowsValid({ indexAll, indexFrom, understandFrom });

  const understandDays = windowDays(understandFrom, nowMs);
  const indexDays = indexAll ? null : windowDays(indexFrom, nowMs);
  const counts = input.counts ?? null;
  const stopAskUsd = input.stopAskUsd ?? DEFAULT_CEILINGS.usdPerDay;

  // 1 · events — exact where exact, a dash where nothing can be counted yet.
  const understandCount = understandFrom === null ? 0 : counts?.understand ?? null;
  const indexCount = counts?.index ?? null;
  const eventsAccuracy: Accuracy = counts?.exact === false ? "about" : "exact";
  const events: CardNumber = {
    value: understandCount,
    unit: "events",
    accuracy: eventsAccuracy,
    display:
      understandCount === null
        ? "—"
        : `${eventsAccuracy === "about" ? "about " : ""}${formatInt(understandCount)}`,
    note:
      understandCount === null
        ? "not counted yet — nothing is sent before this number is real"
        : indexCount === null
          ? null
          : `${formatInt(indexCount)} kept searchable`,
  };

  // 2 · cost — days × $0.0104, ±40%, with the enforced ceiling on the line.
  const costUsd = understandDays * COST_PER_DAY_USD;
  const cost: CardNumber = {
    value: costUsd,
    unit: "usd",
    accuracy: "estimate ±40%",
    display: costUsd === 0 ? "$0" : `about ${formatUsd(costUsd)}`,
    note:
      costUsd === 0
        ? "nothing is sent to a model"
        : `we'll stop and ask if it passes ${formatUsd(stopAskUsd)} in a day`,
  };

  // 3 · time — days × 8.2 s, one call after another. Never the parallel figure.
  const seconds = understandDays * SECONDS_PER_DAY_SERIAL;
  const time: CardNumber = {
    value: seconds,
    unit: "seconds",
    accuracy: "estimate ±30%",
    display: seconds === 0 ? "0 s" : `about ${formatDuration(seconds)}`,
    note: seconds === 0 ? null : "one call after another, newest day first",
  };

  // 4 · disk — the narrow-archive model over the counts we have.
  const diskBytes =
    indexCount === null && understandCount === null
      ? null
      : (indexCount ?? understandCount ?? 0) * BYTES_PER_INDEXED_EVENT +
        (understandCount ?? 0) * BYTES_PER_UNDERSTOOD_EVENT;
  const disk: CardNumber = {
    value: diskBytes,
    unit: "bytes",
    accuracy: "about",
    display: diskBytes === null ? "—" : `about ${formatBytes(diskBytes)}`,
    note: diskBytes === null ? "not counted yet" : "keeping history costs disk; understanding it costs money",
  };

  const card: Omit<ConfirmCard, "text"> = {
    version: CONFIRM_CARD_VERSION,
    source: input.source,
    indexAll,
    indexFrom,
    understandFrom,
    understandDays,
    indexDays,
    events,
    cost,
    time,
    disk,
    stopAskUsd,
    computedAt: new Date(nowMs).toISOString(),
  };
  return { ...card, text: renderCardText(card) };
}

/**
 * The card as the user reads it. Deterministic; every accuracy label on its
 * own number. This exact string is what `confirmConsent` stores.
 */
export function renderCardText(card: Omit<ConfirmCard, "text">): string {
  const label = sourceLabel(card.source);
  const understand =
    card.understandFrom === null
      ? "understand nothing"
      : `understand from ${dayLabel(card.understandFrom)} (${card.understandDays} ${card.understandDays === 1 ? "day" : "days"})`;
  const index = card.indexAll
    ? "keep everything searchable"
    : `keep searchable from ${dayLabel(card.indexFrom!)} (${card.indexDays} ${card.indexDays === 1 ? "day" : "days"})`;
  const line = (name: string, n: CardNumber): string =>
    `${name}: ${n.display} (${n.accuracy})${n.note ? ` — ${n.note}` : ""}`;
  return [
    `${label} · ${understand} · ${index}`,
    line("Events", card.events),
    line("Cost", card.cost),
    line("Time", card.time),
    line("Disk", card.disk),
  ].join("\n");
}

// ---- Counting from the log (re-confirm / widening) --------------------------------

/**
 * Exact counts over the log for a source that already has rows — the
 * re-confirm case, where the adapter's pre-consent count is not the truth
 * any more. First-connect flows pass the adapter's own count instead
 * (nothing is in the log before yes — CNS-01).
 */
export function countEventsInWindows(
  source: string,
  windows: { indexAll: boolean; indexFrom: string | null; understandFrom: string | null },
): CardCounts {
  const db = getDb();
  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM events WHERE source_type = ? AND ts >= ?`,
  );
  const indexFloor = windows.indexAll || windows.indexFrom === null ? "" : windows.indexFrom;
  const index = (total.get(source, indexFloor) as { n: number }).n;
  const understand =
    windows.understandFrom === null ? 0 : (total.get(source, windows.understandFrom) as { n: number }).n;
  return { index, understand, exact: true };
}

// ---- Confirm --------------------------------------------------------------------

export interface ConfirmInput extends CardInput {
  /** Per-source scope (profiles, chats, apps…) stored on the consent row. */
  scope?: unknown;
  grantedBuild?: string | null;
}

export interface ConfirmResult {
  consent: ConsentRow;
  card: ConfirmCard;
  decisionId: string;
  /** "granted" on a first confirm; the window change on a re-confirm. */
  change: "granted" | WindowChange["direction"];
  /** Archive rows replayed into the Understand tier on a widening. */
  replayed: number;
}

/**
 * The user pressed Confirm. In one transaction:
 *   1. build the card (throws before any write on invalid windows),
 *   2. grant the consent (first time) or move its windows (re-confirm —
 *      widening replays the archive, CNS-04),
 *   3. write the decision row with the card text verbatim,
 *   4. point `consents.decision_id` at it.
 *
 * When `counts` is absent: a re-confirm counts the log (exact); a first
 * connect shows a dash — nothing is measured yet. Starting the adapter is the caller's job
 * (adapters/supervisor.ts `start(source)`), so this stays a pure DB write.
 */
export function confirmConsent(input: ConfirmInput): ConfirmResult {
  const db = getDb();
  const indexAll = input.indexAll ?? input.indexFrom == null;
  const windows = {
    indexAll,
    indexFrom: indexAll ? null : (input.indexFrom ?? null),
    understandFrom: input.understandFrom ?? null,
  };
  assertWindowsValid(windows);
  // No counts from the flow: on a re-confirm the log is the truth; on a first
  // connect nothing has been looked at yet (CNS-01), so the card shows a dash
  // rather than a "0" the code did not measure.
  const counts =
    input.counts ?? (getConsent(input.source) ? countEventsInWindows(input.source, windows) : null);
  const card = buildConfirmCard({ ...input, counts });

  const run = db.transaction((): ConfirmResult => {
    const before = getConsent(input.source);
    let consent: ConsentRow;
    let change: ConfirmResult["change"];
    let replayed = 0;
    if (!before) {
      consent = grantConsent({
        source: input.source,
        indexAll: windows.indexAll,
        indexFrom: windows.indexFrom,
        understandFrom: windows.understandFrom,
        scope: input.scope,
        grantedBuild: input.grantedBuild,
      });
      change = "granted";
    } else {
      // Index first so the CNS-03 check sees the pair the user actually chose.
      setConsentWindows(input.source, { indexAll: windows.indexAll, indexFrom: windows.indexFrom });
      const moved = setUnderstandWindow(input.source, windows.understandFrom);
      consent = moved.consent;
      change = moved.direction;
      replayed = moved.replay.replayed;
      if (input.scope !== undefined) {
        db.prepare(`UPDATE consents SET scope_json = ? WHERE id = ?`).run(
          JSON.stringify(input.scope),
          consent.id,
        );
      }
    }
    const decisionId = writeDecision({
      pass: "user",
      targetKind: "consent",
      targetId: consent.id,
      action: before ? "reconfirm" : "confirm",
      old: before
        ? { indexAll: before.indexAll, indexFrom: before.indexFrom, understandFrom: before.understandFrom }
        : null,
      new: card,
      reason: card.text,
      confidence: null,
    });
    db.prepare(`UPDATE consents SET decision_id = ?, updated_at = ? WHERE id = ?`).run(
      decisionId,
      new Date(input.nowMs ?? Date.now()).toISOString(),
      consent.id,
    );
    consent = { ...consent, decisionId };
    return { consent, card, decisionId, change, replayed };
  });
  return run();
}

/** The card text a consent row was confirmed with, verbatim, or null. */
export function confirmedCardText(consent: ConsentRow): string | null {
  if (!consent.decisionId) return null;
  const row = getDb()
    .prepare(`SELECT reason FROM decisions WHERE id = ?`)
    .get(consent.decisionId) as { reason: string | null } | undefined;
  return row?.reason ?? null;
}
