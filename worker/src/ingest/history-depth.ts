// ===========================================================================
// [CODE] Did WhatsApp actually re-upload the history, or just the bootstrap?
//
// WhatsApp pushes a linked device's full archive ONCE, right after linking, as
// one small INITIAL_BOOTSTRAP payload followed by twenty to thirty FULL chunks
// over ~6 minutes. The server may decline the bulk re-upload — on the observed
// failure it sent the bootstrap batch (486 message secrets) and then nothing
// for 78 minutes. The daemon's `backfill_complete` frame fires either way, so
// the import "finished" and the user was shown a full Inbox holding one message
// per chat, with no signal that anything was missing.
//
// This module decides, from evidence only, which of the two happened. It is
// pure: no timers, no DB, no I/O. The stateful half lives in history-health.ts.
//
// TWO INDEPENDENT SIGNALS, because one of them may not exist:
//
//   1. SYNC TYPES — the daemon's per-payload `history_sync` frames. If a FULL
//      (or ON_DEMAND) payload was processed, WhatsApp did send bulk. This is
//      the strong signal, and it only exists once the daemon emits the frame.
//   2. SHAPE — chats / messages / single-message chats read back from the DB.
//      Works with no daemon change at all, which is why it is the fallback.
//
// The thresholds are drawn through a measured 10x gap (db/history-shape.ts):
// a declined re-upload left 3.4 messages per chat with 68.5% of chats holding
// exactly one; the two healthy installs left 36-37 per chat with 36-37% holding
// one. Both conditions must hold, and only above a floor of chats, so a genuinely
// small account is never accused of a failed sync.
// ===========================================================================

import type { HistoryShape } from "../db/history-shape.js";
import type { HistoryDepth, HistorySyncPayload } from "../adapters/types.js";

/**
 * How long ingest must be quiet before the shape is judged. A healthy sync's
 * FULL chunks land every ~12-18s across its ~6 minutes, so a full minute of
 * silence means WhatsApp has stopped sending, not that it is between chunks.
 */
export const HISTORY_QUIET_MS = 60_000;

/** Below this many chats an install is too small to draw a conclusion from. */
export const MIN_CHATS_TO_JUDGE = 10;

/** Measured: 3.43 on the declined sync, 35.75-37.06 on the healthy ones. */
export const MAX_AVG_MESSAGES_PER_CHAT = 10;

/** Measured: 0.685 on the declined sync, 0.357-0.370 on the healthy ones. */
export const MIN_SINGLE_MESSAGE_FRACTION = 0.5;

/**
 * Sync types that mean WhatsApp sent BULK history rather than just enough to
 * name the chats. ON_DEMAND counts: it is what "Extend history" asks for, and a
 * page that came back is history that arrived.
 *
 * Compared as strings so a sync type added to whatsmeow later travels through
 * untouched instead of needing a matching release here.
 */
const BULK_SYNC_TYPES = new Set(["FULL", "ON_DEMAND"]);

/**
 * Running totals over the daemon's per-payload `history_sync` frames. Kept as
 * an aggregate rather than an array so a six-hour session cannot grow it.
 */
export interface PayloadTally {
  /** Payloads reported. 0 means the daemon told us nothing (frame absent). */
  count: number;
  /** Of those, ones carrying bulk history (FULL / ON_DEMAND). */
  bulk: number;
  /** Distinct sync types seen, in arrival order. Bounded by the enum. */
  syncTypes: string[];
  messagesSeen: number;
  messagesInRange: number;
  messagesEmitted: number;
  messagesFiltered: number;
}

export function emptyTally(): PayloadTally {
  return {
    count: 0,
    bulk: 0,
    syncTypes: [],
    messagesSeen: 0,
    messagesInRange: 0,
    messagesEmitted: 0,
    messagesFiltered: 0,
  };
}

/** Fold one daemon payload frame into the running tally. Mutates in place. */
export function tallyPayload(tally: PayloadTally, p: HistorySyncPayload): void {
  tally.count += 1;
  if (BULK_SYNC_TYPES.has(p.syncType)) tally.bulk += 1;
  if (p.syncType && !tally.syncTypes.includes(p.syncType)) {
    tally.syncTypes.push(p.syncType);
  }
  tally.messagesSeen += p.messagesSeen;
  tally.messagesInRange += p.messagesInRange;
  tally.messagesEmitted += p.messagesEmitted;
  tally.messagesFiltered += p.messagesFiltered;
}

export interface HistoryEvidence {
  shape: HistoryShape;
  tally: PayloadTally;
  /** Injected in tests; defaults to now. */
  now?: Date;
}

/**
 * Is the imported history implausibly thin for the number of chats in it?
 * Exported so the test can state the two real installs' numbers directly.
 */
export function isSparseShape(shape: HistoryShape): boolean {
  if (shape.chats < MIN_CHATS_TO_JUDGE) return false;
  const avg = shape.messages / shape.chats;
  const singleFraction = shape.singleMessageChats / shape.chats;
  return (
    avg < MAX_AVG_MESSAGES_PER_CHAT &&
    singleFraction >= MIN_SINGLE_MESSAGE_FRACTION
  );
}

/**
 * Judge one settled import. Never throws, never guesses past the evidence: when
 * the two signals disagree the verdict is `unknown`, because telling the user
 * "WhatsApp declined" while the daemon reports FULL payloads arriving would be
 * a confident lie, and a wrong hypothesis has already cost this investigation
 * one night.
 */
export function assessHistoryDepth(ev: HistoryEvidence): HistoryDepth {
  const { shape, tally } = ev;
  const base = {
    chats: shape.chats,
    messages: shape.messages,
    singleMessageChats: shape.singleMessageChats,
    payloads: tally.count,
    bulkPayloads: tally.bulk,
    syncTypes: [...tally.syncTypes],
    messagesSeen: tally.messagesSeen,
    messagesEmitted: tally.messagesEmitted,
    messagesFiltered: tally.messagesFiltered,
    syncTypesKnown: tally.count > 0,
    checkedAt: (ev.now ?? new Date()).toISOString(),
  };

  // Nothing landed at all. That is a different problem (not paired, wrong
  // range, daemon down) and a different message, so do not claim this one.
  if (shape.chats === 0) {
    return { ...base, verdict: "unknown", reason: "no_history" };
  }

  if (!isSparseShape(shape)) {
    return {
      ...base,
      verdict: "deep",
      reason: base.bulkPayloads > 0 ? "bulk_received" : "healthy_shape",
    };
  }

  // Sparse — but the daemon says bulk payloads DID arrive. Then the loss is
  // somewhere after WhatsApp, and "WhatsApp declined" is the wrong story.
  if (base.bulkPayloads > 0) {
    return { ...base, verdict: "unknown", reason: "sparse_after_bulk" };
  }

  return {
    ...base,
    verdict: "shallow",
    reason: base.syncTypesKnown ? "bootstrap_only" : "sparse_chats",
  };
}
