// [CODE] One session, fully explained — arch §14.2.
//
//   ▸ WhatsApp · Pranjali          09:12–09:41 · 14 events · conversation
//      START: gap 7h20m > 6h            END: debounce 45m idle ≥ 45m
//      seal_mode: debounce · hash 3f9a… ✓understood
//      ⏳ 1 voice note pending · text understood immediately
//      ↻ reprocessed at 14:53 (reprocess_count 1)
//
// §14.2 in one sentence: "every session shows BOTH boundaries with the rule and
// measured value, its seal_mode, its enrichment state, and any reprocess
// history". Both boundaries are therefore unconditional — an open session
// prints why it has no end rule rather than leaving the slot blank.
//
// An open session is live, provisional output (§14.0b): it is marked
// "conversation in progress", and everything it shows may still change.

import { boundaryLine } from "./boundary";
import type { SessionView } from "../../lib/surfaces-client";

export interface SessionCardProps {
  session: SessionView;
  /** Vanished from a refresh while still open — kept, not silently dropped. */
  retracted?: boolean;
  onDismissRetracted?(id: string): void;
  onReplayStream(streamId: string): void;
}

function clock(iso: string | null): string {
  if (!iso) return "??:??";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "??:??";
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** `3f9a…` — enough to compare two hashes by eye, short enough to sit inline. */
export function shortHash(hash: string | null): string {
  return hash ? `${hash.slice(0, 4)}…` : "not hashed yet";
}

export function SessionCard({
  session,
  retracted = false,
  onDismissRetracted,
  onReplayStream,
}: SessionCardProps) {
  const open = session.status === "open";

  return (
    <li
      className={
        "session" +
        (open ? " session--open" : "") +
        (retracted ? " session--retracted" : "") +
        (session.lateArrival ? " session--late" : "")
      }
      data-session-id={session.id}
    >
      {retracted && (
        <p className="session__retracted" role="status">
          <span aria-hidden="true">◍ </span>
          no longer listed — this open session was re-segmented or sealed away
          <button type="button" onClick={() => onDismissRetracted?.(session.id)}>
            dismiss
          </button>
        </p>
      )}

      <header className="session__head">
        <span className="session__where">
          {session.sourceLabel} · {session.streamLabel}
        </span>
        <span className="session__when">
          {clock(session.startedAt)}–{clock(session.endedAt)}
        </span>
        <span className="session__facts">
          {session.eventCount} events · {session.kind}
        </span>
        {session.lateArrival && (
          <span className="session__late" title={`overlaps ${session.overlapOf ?? "a sealed session"}`}>
            late arrival
          </span>
        )}
      </header>

      {/* §14.0b — live, provisional, and saying so. */}
      {open && (
        <p className="session__live">
          <span aria-hidden="true">◍ </span>
          conversation in progress — this session is still open and may change
        </p>
      )}

      <p className="session__boundary">
        {boundaryLine("START", session.boundaryStart, session.status)}
      </p>
      <p className="session__boundary">
        {boundaryLine("END", session.boundaryEnd, session.status)}
      </p>

      <p className="session__seal">
        seal_mode: {session.sealMode ?? "not sealed"} · hash {shortHash(session.contentHash)}
        {session.supersededHash ? ` · supersedes ${shortHash(session.supersededHash)}` : ""} ·{" "}
        {session.understood ? "✓understood" : "⏳ understanding pending"}
      </p>

      <p className="session__participants">
        participants: {session.participants.length > 0 ? session.participants.join(", ") : "none recorded"}
      </p>

      {(session.pendingEnrichmentCount > 0 || session.enrichmentNote) && (
        <p className="session__enrichment">
          <span aria-hidden="true">⏳ </span>
          {session.enrichmentNote ?? `${session.pendingEnrichmentCount} enrichment pending`}
        </p>
      )}

      {session.reprocessCount > 0 && (
        <p className="session__reprocess">
          <span aria-hidden="true">↻ </span>
          reprocessed{session.reprocessedAt ? ` at ${clock(session.reprocessedAt)}` : ""}
          {session.reprocessReason ? ` — ${session.reprocessReason}` : ""} (reprocess_count{" "}
          {session.reprocessCount})
        </p>
      )}

      <p className="session__actions">
        <button
          type="button"
          disabled={!session.streamId}
          onClick={() => session.streamId && onReplayStream(session.streamId)}
        >
          replay stream
        </button>
      </p>
    </li>
  );
}
