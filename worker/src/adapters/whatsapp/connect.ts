// ===========================================================================
// WhatsApp connect flow — V6 P1 S1.5 (Build §4.2, backlog T4-7, T4-10).
//
//   pair → buffer → counts → windows → confirm
//
//   pair      POST /api/sources/whatsapp/pair spawns the daemon (the one
//             pre-consent spawn, supervisor.ensureWhatsAppDaemon) and shows the
//             QR. Nothing it emits reaches the log: no consent row yet (S1.2).
//   buffer    WhatsApp pushes the device's history within seconds of pairing.
//             The daemon HOLDS it (no range installed) — and holds live
//             messages too (S1.5: no live ingest between pairing and confirm).
//   counts    GET /api/sources/whatsapp/counts → `count_range` → the daemon
//             MEASURES what each window would import over what it holds
//             (rangefilter.CountByRange, the same two filters an import runs).
//             `describeWindows` turns that into card rows; `countsCaveats`
//             prints the honest caveats (bootstrap-only, how far back, held
//             live messages) the HistoryDepth machinery would otherwise only
//             compute after the fact.
//   windows   The user picks INDEX (default everything) and UNDERSTAND
//             (default 30 d). Understand can never exceed Index (CNS-03).
//   confirm   POST /api/sources/whatsapp/confirm { index, understand,
//             card_text } → `confirmWhatsAppWindows`: the card text is stored
//             VERBATIM in `decisions` first, then the consent row is granted
//             pointing at it (consents.decision_id, T4-10 / CNS-09), then the
//             route sends `import <index>` — the daemon drains its buffer
//             filtered by the confirmed window, releases the held live
//             messages, and the funnel — now with a connected row — admits them.
//
// Pure over (counts, clock, DB). Zero model calls.
// ===========================================================================

import { getDb } from "../../db/connection.js";
import { writeDecision } from "../../db/decisions.js";
import {
  ConsentWindowError,
  grantConsent,
  type ConsentRow,
} from "../../db/v6core.js";
import { rangeCutoffIso } from "../source-adapter.js";
import { isRange, RANGES, type Range, type RangeCounts } from "../types.js";

/** The consent row's source key is the adapter's source id (the funnel keys on it). */
export const WHATSAPP_SOURCE = "whatsapp";

/** Default windows (Product_V6_Phase1 §consent: Index everything, Understand 30 d). */
export const DEFAULT_INDEX_WINDOW: Range = "all";
export const DEFAULT_UNDERSTAND_WINDOW: Range = "30d";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Nominal length of a window in days ("all" has none — see describeWindows). */
export const WINDOW_DAYS: Record<Exclude<Range, "all">, number> = {
  "24h": 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "1y": 365,
  "2y": 730,
  "3y": 1095,
  "4y": 1460,
  "5y": 1825,
};

/** Sync types that mean WhatsApp sent bulk history, not just the bootstrap. */
const BULK_SYNC_TYPES = new Set(["FULL", "RECENT", "ON_DEMAND"]);

/** Ascending-duration rank; "all" is the widest. */
function rank(r: Range): number {
  return RANGES.indexOf(r);
}

/** Thrown for a malformed or inconsistent window choice (400 at the route). */
export class WindowChoiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowChoiceError";
  }
}

export interface WindowChoice {
  /** INDEX window — what is kept and searchable. */
  index: Range;
  /** UNDERSTAND window — what the model reads. null = nothing goes to the model. */
  understand: Range | null;
}

/**
 * Validate a window choice: both must be known ranges and Understand can never
 * reach further back than Index (CNS-03). Accepts the raw request body shape.
 */
export function parseWindowChoice(input: {
  index?: unknown;
  understand?: unknown;
}): WindowChoice {
  const index = input.index === undefined ? DEFAULT_INDEX_WINDOW : input.index;
  if (!isRange(index)) {
    throw new WindowChoiceError(`index must be one of ${RANGES.join(" ")}`);
  }
  let understand: Range | null;
  if (input.understand === undefined) understand = DEFAULT_UNDERSTAND_WINDOW;
  else if (input.understand === null) understand = null;
  else if (isRange(input.understand)) understand = input.understand;
  else {
    throw new WindowChoiceError(
      `understand must be null or one of ${RANGES.join(" ")}`,
    );
  }
  if (understand !== null && rank(understand) > rank(index)) {
    throw new WindowChoiceError(
      `understand (${understand}) reaches further back than index (${index}); Understand never exceeds Index`,
    );
  }
  return { index, understand };
}

/** The consent-row floors for a choice: `all` → indexAll, else an ISO cutoff. */
export function windowFloors(
  choice: WindowChoice,
  nowMs: number = Date.now(),
): {
  indexAll: boolean;
  indexFrom: string | null;
  understandFrom: string | null;
} {
  const indexAll = choice.index === "all";
  return {
    indexAll,
    indexFrom: indexAll ? null : rangeCutoffIso(choice.index, nowMs),
    understandFrom:
      choice.understand === null
        ? null
        : choice.understand === "all"
          ? new Date(0).toISOString()
          : rangeCutoffIso(choice.understand, nowMs),
  };
}

// ---- Card rows --------------------------------------------------------------

export interface WindowRow {
  range: Range;
  chats: number;
  messages: number;
  /**
   * Days the window spans. For `all` this is the span of history actually
   * received (oldestTs → now), so a cost/time estimate built on it describes
   * what will really be processed.
   */
  days: number;
  /**
   * "measured": counted over what WhatsApp has sent, and WhatsApp has sent
   * bulk history. "so-far": counted, but only the bootstrap batch has arrived —
   * the number will rise. "none": nothing received yet.
   */
  accuracy: "measured" | "so-far" | "none";
}

/** One row per window, from the daemon's measured counts. */
export function describeWindows(
  counts: RangeCounts,
  nowMs: number = Date.now(),
): WindowRow[] {
  const accuracy: WindowRow["accuracy"] =
    counts.batches === 0
      ? "none"
      : counts.syncTypes.some((t) => BULK_SYNC_TYPES.has(t))
        ? "measured"
        : "so-far";
  const oldest = counts.oldestTs ? Date.parse(counts.oldestTs) : NaN;
  const spanDays = Number.isFinite(oldest)
    ? Math.max(1, Math.ceil((nowMs - oldest) / DAY_MS))
    : 0;
  return RANGES.map((range) => {
    const c = counts.counts[range] ?? { chats: 0, messages: 0 };
    // A window wider than the history received cannot process more days than
    // exist: cap nominal days at the span, so 5y over 400 days of history says
    // 400 days, not 1,825.
    const nominal = range === "all" ? spanDays : WINDOW_DAYS[range];
    const days =
      range === "all"
        ? spanDays
        : spanDays > 0
          ? Math.min(nominal, spanDays)
          : nominal;
    return { range, chats: c.chats, messages: c.messages, days, accuracy };
  });
}

/**
 * The honest caveats the card prints under the numbers. Every line is a fact
 * the counts frame carries — nothing is guessed.
 */
export function countsCaveats(
  counts: RangeCounts,
  nowMs: number = Date.now(),
): string[] {
  const out: string[] = [];
  if (counts.batches === 0) {
    out.push(
      "WhatsApp hasn't sent any history yet. Keep your phone online; the counts fill in as it arrives.",
    );
  } else if (!counts.syncTypes.some((t) => BULK_SYNC_TYPES.has(t))) {
    out.push(
      "WhatsApp has sent only its first bootstrap batch so far. These counts will rise as the full history lands (usually within a few minutes) — confirm now and the rest is imported as it arrives.",
    );
  }
  if (counts.oldestTs) {
    const oldest = Date.parse(counts.oldestTs);
    const days = Number.isFinite(oldest)
      ? Math.max(1, Math.round((nowMs - oldest) / DAY_MS))
      : null;
    out.push(
      `What arrived reaches back to ${counts.oldestTs.slice(0, 10)}${days ? ` (${days} days)` : ""}. “Everything” means everything WhatsApp has sent this device, not everything on your phone.`,
    );
  }
  if (counts.pendingLive > 0) {
    out.push(
      `${counts.pendingLive} message${counts.pendingLive === 1 ? "" : "s"} arrived since pairing and ${counts.pendingLive === 1 ? "is" : "are"} held until you confirm — nothing is read before then.`,
    );
  }
  if (counts.rangeInstalled) {
    out.push(
      `A window (${counts.range ?? "?"}) is already confirmed; history is flowing.`,
    );
  }
  return out;
}

// ---- Confirm ----------------------------------------------------------------

export interface ConfirmInput extends WindowChoice {
  /** The confirm card's text, stored VERBATIM (T4-10 / CNS-09). */
  cardText: string;
  /** The counts the card was built from, kept beside the text. */
  counts?: RangeCounts | null;
  nowMs?: number;
}

export interface ConfirmResult {
  choice: WindowChoice;
  consent: ConsentRow;
  decisionId: string;
  floors: ReturnType<typeof windowFloors>;
}

/**
 * Record the user's yes: the card text goes into `decisions` first, verbatim
 * (`new_json.card_text`, and `reason` for the "why?" surface), then the consent
 * row is granted pointing at it. Any live row for the source is superseded by
 * `grantConsent`. Throws WindowChoiceError / ConsentWindowError with nothing
 * written when the windows are inconsistent — the decisions row is written
 * only after validation passes.
 */
export function confirmWhatsAppWindows(input: ConfirmInput): ConfirmResult {
  const choice = parseWindowChoice({
    index: input.index,
    understand: input.understand,
  });
  const nowMs = input.nowMs ?? Date.now();
  const floors = windowFloors(choice, nowMs);
  const cardText = typeof input.cardText === "string" ? input.cardText : "";
  // One transaction: the decisions row and the consent row land together or
  // not at all (grantConsent's own transaction nests as a savepoint).
  const tx = getDb().transaction((): ConfirmResult => {
    const decisionId = writeDecision({
      pass: "user",
      targetKind: "consent",
      targetId: WHATSAPP_SOURCE,
      action: "grant",
      old: null,
      new: {
        source: WHATSAPP_SOURCE,
        index: choice.index,
        understand: choice.understand,
        index_from: floors.indexFrom,
        index_all: floors.indexAll,
        understand_from: floors.understandFrom,
        confirmed_at: new Date(nowMs).toISOString(),
        card_text: cardText,
        counts: input.counts ?? null,
      },
      reason: cardText,
      confidence: 1,
    });
    let consent: ConsentRow;
    try {
      consent = grantConsent({
        source: WHATSAPP_SOURCE,
        state: "connected",
        indexAll: floors.indexAll,
        indexFrom: floors.indexFrom,
        understandFrom: floors.understandFrom,
        decisionId,
        scope: { index: choice.index, understand: choice.understand },
        grantedAt: new Date(nowMs).toISOString(),
      });
    } catch (err) {
      // parseWindowChoice already rejects the only inconsistent shape, so this
      // is a belt: surface the DB-side check under the same name.
      if (err instanceof ConsentWindowError)
        throw new WindowChoiceError(err.message);
      throw err;
    }
    return { choice, consent, decisionId, floors };
  });
  return tx();
}
