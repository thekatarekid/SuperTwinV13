// Honest reporting for a history sync that only half-happened.
//
// WhatsApp pushes a linked device's archive ONCE, right after linking: one small
// bootstrap batch that names the chats, then twenty-odd bulk chunks carrying the
// actual messages. The server can decline the bulk half — and when it does, the
// import still reports "complete", the Inbox still fills with chat rows, and
// every row opens onto a single message. Nothing in the old UI said so.
//
// These two strips say so. Neither ever triggers a re-link: WhatsApp grants one
// full push per link, so spending one on the user's behalf would be the most
// expensive thing this screen could do. The only offered action is "Extend
// history", which asks for older pages over the existing session.

import {
  RANGE_LABELS,
  type ExtendOutcome,
  type HistoryDepth,
} from "../lib/worker-client";

/**
 * Shown when the worker judged the import SHALLOW. The copy states what
 * arrived, names WhatsApp (not the user) as the party that decided, and offers
 * the one recovery action that exists.
 */
export function ShallowHistoryNotice({
  depth,
  onExtend,
}: {
  depth: HistoryDepth;
  onExtend(): void;
}) {
  return (
    <div className="inbox__depth-banner" role="status" aria-live="polite">
      <span className="inbox__depth-banner-text">
        <strong>WhatsApp sent a short history.</strong>{" "}
        {describeShallow(depth)} WhatsApp decides how much history it re-uploads
        to a linked device, and this time it sent only the opening batch —
        nothing on your side went wrong. “Extend history” asks for older messages
        over the connection you already have.
      </span>
      <button
        type="button"
        className="wa-btn wa-btn--primary inbox__depth-banner-action"
        onClick={onExtend}
      >
        Extend history
      </button>
    </div>
  );
}

/** "305 messages across 89 chats arrived, and 61 of them hold one message." */
function describeShallow(depth: HistoryDepth): string {
  const { chats, messages, singleMessageChats } = depth;
  const single =
    singleMessageChats > 0
      ? ` ${singleMessageChats} of them hold a single message.`
      : "";
  return `${messages.toLocaleString()} messages across ${chats.toLocaleString()} chats arrived.${single}`;
}

/**
 * Shown after an "Extend history" run so the button stops being a no-feedback
 * click. Reports rows that actually PERSISTED — a run that re-fetched pages
 * already stored says 0, because 0 is what it recovered.
 */
export function ExtendResultNotice({
  outcome,
  onDismiss,
}: {
  outcome: ExtendOutcome;
  onDismiss(): void;
}) {
  const label = RANGE_LABELS[outcome.range] ?? outcome.range;
  return (
    <div className="inbox__extend-banner" role="status" aria-live="polite">
      {outcome.running && (
        <span className="wa-spinner wa-spinner--sm" aria-hidden="true" />
      )}
      <span className="inbox__extend-banner-text">
        <strong>Extend history ({label}):</strong> {describeExtend(outcome)}
      </span>
      {!outcome.running && (
        <button
          type="button"
          className="wa-btn wa-btn--ghost inbox__extend-banner-dismiss"
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}

function describeExtend(outcome: ExtendOutcome): string {
  if (outcome.running) return "fetching older messages…";
  if (outcome.messagesRecovered === 0) {
    // Distinguish "asked nobody" from "asked and got nothing" — the first is a
    // reason to try a wider range, the second means the range is exhausted.
    return outcome.chatsPaginated === 0
      ? "no chats were paginated, so nothing was requested. Try a wider range."
      : `no older messages came back for ${outcome.chatsPaginated.toLocaleString()} chats. WhatsApp has nothing more to send for this range.`;
  }
  const chats = outcome.streamsWithNewMessages.toLocaleString();
  const msgs = outcome.messagesRecovered.toLocaleString();
  const more = outcome.mayHaveMore
    ? " WhatsApp returns up to 50 messages per chat per request, so run it again if chats still look short."
    : "";
  return `recovered ${msgs} messages across ${chats} chats.${more}`;
}
