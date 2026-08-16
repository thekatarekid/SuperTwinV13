// ===========================================================================
// [CODE] Business-channel content heuristics — arch §9.3, build item 1.2.
//
// §9.3 splits business senders into T2 TRANSACTIONAL and T4 PROMOTIONAL, and
// is explicit about the order of work:
//
//   [CODE] heuristics FIRST — order/booking/PNR ids, amounts, due dates,
//          "your order|booking|appointment|statement|payment"  -> T2
//          "% off", "sale", "limited time", "unsubscribe", campaign
//          formatting, no user-specific identifiers            -> T4
//   ambiguous -> P-TI1, ONE haiku call PER CHANNEL
//
// So this file's job is not to classify every channel. It is to classify the
// ones a regular expression genuinely can, and to hand everything else on
// UNDECIDED. `ambiguous` is a first-class verdict here, not a failure: a
// heuristic that guesses to avoid a model call is the expensive kind of cheap.
//
// Two rules shape the signal table:
//
//   * THE TELL IS SPECIFICITY (§12.11). An order id, a masked account, a due
//     date, a delivery notice — those name THIS person's affairs. A campaign
//     names nobody.
//   * AN AMOUNT ALONE IS NOT A TELL. "Rs.150 off your next order" is a
//     campaign with a number in it. An amount only speaks for `tx` when the
//     message carries no campaign cue, which is why it is scored weakly and
//     last.
//
// Nothing here decides whether a channel's messages are processed — only when
// (§9.3 rule 1). A T4 verdict delays a bill; it never drops one.
// ===========================================================================

import type { Tier } from "./priority.js";

/** The two classes P-TI1 also speaks (STW-2 enum `channel_class`). */
export type ChannelClass = "tx" | "pm";

/** What a [CODE] pass can conclude. `ambiguous` is the handover to P-TI1. */
export type ChannelVerdict = ChannelClass | "ambiguous";

export interface MessageSignals {
  /** Names this person's own affairs — an id, a masked account, a due date. */
  strongTx: string[];
  /** An amount, and nothing else. Only counts when no campaign cue is present. */
  weakTx: string[];
  /** Campaign cues — offers, urgency, unsubscribe footers, shouting. */
  pm: string[];
  verdict: "tx" | "pm" | "neutral";
}

export interface SampleClassification {
  verdict: ChannelVerdict;
  /** 0…1. Null when undecided — an ambiguous channel has no code confidence. */
  confidence: number | null;
  /** The rule that fired, stable enough to assert on. */
  rule: "business_tx_code" | "business_pm_code" | "business_ambiguous";
  reason: string;
  counts: { messages: number; tx: number; pm: number; neutral: number };
  signals: MessageSignals[];
}

// ---- the signal table ------------------------------------------------------

/** Order / booking / PNR / policy / invoice ids — §9.3's first tell. */
const ID_RE =
  /\b(?:order|booking|pnr|awb|reference|ref|invoice|txn|transaction|ticket|policy|reservation|consignment|tracking)\s*(?:id|no\.?|number|#)?\s*[:#-]?\s*(?=[a-z0-9-]*\d)[a-z0-9][a-z0-9-]{4,}\b/i;

/** `a/c XX4412`, `card ending 8891`, `account ...4412`. */
const MASKED_ACCOUNT_RE = /\b(?:a\/c|acct|account|card)\b[^.\n]{0,20}?(?:ending|xx+|\*{2,}|no\.?|number)\s*[x*]*\d{3,}/i;

/** A due date: `due by 05-Sep`, `before 12 Aug`, `due on 2026-09-05`. */
const DUE_DATE_RE =
  /\b(?:due|expires?|payable|last date|valid till|before|by)\b[^.\n]{0,16}?(?:\d{1,2}[-/ ](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{4}-\d{2}-\d{2}|\d{1,2}[-/]\d{1,2}(?:[-/]\d{2,4})?)/i;

/** "your order|booking|appointment|statement|payment", and their neighbours. */
const TX_KEYWORD_RE =
  /\b(?:your (?:order|booking|appointment|statement|payment|policy|subscription|delivery|shipment|reservation|ticket|refund|premium|package|parcel)|statement (?:for|is)|has been (?:delivered|dispatched|shipped|confirmed|booked)|out for delivery|debited|credited|payment (?:received|due|failed)|appointment (?:on|with|reminder)|otp\b|one[- ]time password|e-?ticket|check[- ]in (?:is )?open|bill (?:is )?(?:ready|generated|due)|total due|amount due|emi\b|has been (?:placed|received))/i;

/** An amount. Weak on its own — see the header. */
const AMOUNT_RE = /(?:rs\.?|inr|₹|\$|usd|eur|£|aed)\s?\d[\d,]*(?:\.\d+)?/i;

/** `60% OFF`, `flat 20 % discount`, `upto 50% off`. */
const PERCENT_OFF_RE = /\b\d{1,3}\s*%\s*(?:off|discount)\b/i;

/** The campaign vocabulary §9.3 names, plus its usual company. */
const PM_KEYWORD_RE =
  /\b(?:limited time|limited period|hurry|last chance|ends (?:today|tonight|soon)|offer ends|unsubscribe|opt[- ]out|sale\b|mega sale|biggest sale|flat \d|use code|promo code|coupon|voucher|shop now|buy now|order now|book now|grab (?:it|yours|now)|we miss you|come back|exclusive (?:offer|deal|price)|deal of the day|new (?:arrivals|launch|collection)|newsletter|introducing our|don'?t miss|save big|free delivery on (?:orders|your first)|refer (?:and|&) earn|cashback offer|starting at just|only for you today)/i;

/** Campaign formatting: shouted words and pile-ups of exclamation marks. */
function campaignFormatting(text: string): boolean {
  if (/!{2,}/.test(text)) return true;
  const shouted = text.match(/\b[A-Z][A-Z0-9]{2,}\b/g) ?? [];
  return shouted.length >= 3;
}

function hit(list: string[], name: string, re: RegExp, text: string): void {
  if (re.test(text)) list.push(name);
}

/** Score one message. Pure, and it never rewrites the message. */
export function signalsFor(message: string): MessageSignals {
  const text = typeof message === "string" ? message : "";
  const strongTx: string[] = [];
  const weakTx: string[] = [];
  const pm: string[] = [];

  hit(strongTx, "id", ID_RE, text);
  hit(strongTx, "masked_account", MASKED_ACCOUNT_RE, text);
  hit(strongTx, "due_date", DUE_DATE_RE, text);
  hit(strongTx, "tx_keyword", TX_KEYWORD_RE, text);
  hit(weakTx, "amount", AMOUNT_RE, text);
  hit(pm, "percent_off", PERCENT_OFF_RE, text);
  hit(pm, "campaign_keyword", PM_KEYWORD_RE, text);
  if (campaignFormatting(text)) pm.push("campaign_formatting");

  // Order matters and is the whole argument: a message that names this
  // person's order is transactional even if it also shouts; a campaign with a
  // rupee figure in it is still a campaign.
  const verdict = strongTx.length > 0 ? "tx" : pm.length > 0 ? "pm" : weakTx.length > 0 ? "tx" : "neutral";
  return { strongTx, weakTx, pm, verdict };
}

/** Below this share of the sample, [CODE] does not get to decide. */
const DECIDE_SHARE = 0.5;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Classify a channel from a SAMPLE of its messages (§12.11: "Judge the CHANNEL
 * by its sample, not any single message").
 *
 * Code decides only when the sample is one-sided: every judged message points
 * the same way and at least half the sample was judged at all. Anything mixed
 * — a promotional channel with one delivery notice in it, a bank that also
 * markets — is `ambiguous` and belongs to P-TI1, which is exactly the case
 * §12.11's tie-break rule exists for.
 */
export function classifyBusinessSample(messages: readonly string[]): SampleClassification {
  const sample = (messages ?? []).filter((m) => typeof m === "string" && m.trim() !== "");
  const signals = sample.map(signalsFor);
  const tx = signals.filter((s) => s.verdict === "tx").length;
  const pm = signals.filter((s) => s.verdict === "pm").length;
  const neutral = signals.length - tx - pm;
  const counts = { messages: signals.length, tx, pm, neutral };

  const ambiguous = (reason: string): SampleClassification => ({
    verdict: "ambiguous",
    confidence: null,
    rule: "business_ambiguous",
    reason,
    counts,
    signals,
  });

  if (signals.length === 0) return ambiguous("no sample to judge");
  if (tx > 0 && pm > 0) {
    return ambiguous(`sample is mixed — ${tx} transactional and ${pm} promotional of ${signals.length}`);
  }

  const share = (tx + pm) / signals.length;
  if (share < DECIDE_SHARE) {
    return ambiguous(`only ${tx + pm} of ${signals.length} sample messages carry a usable signal`);
  }

  if (tx > 0) {
    return {
      verdict: "tx",
      confidence: round2(Math.min(0.95, 0.7 + 0.25 * share)),
      rule: "business_tx_code",
      reason: `${tx} of ${signals.length} sample messages name this person's own order, account, amount or due date`,
      counts,
      signals,
    };
  }
  return {
    verdict: "pm",
    confidence: round2(Math.min(0.95, 0.7 + 0.25 * share)),
    rule: "business_pm_code",
    reason: `${pm} of ${signals.length} sample messages are campaign copy with no user-specific identifier`,
    counts,
    signals,
  };
}

/** §9.3's split, and the only place the mapping is written down. */
export function tierForChannelClass(cls: ChannelClass): Tier {
  return cls === "tx" ? "T2" : "T4";
}

/** The STW-2 stored spelling of a class, for `tier_reason` and the log. */
export function channelClassLabel(cls: ChannelClass): string {
  return cls === "tx" ? "transactional" : "promotional";
}
