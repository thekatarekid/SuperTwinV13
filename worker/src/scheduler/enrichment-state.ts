// ===========================================================================
// [CODE] One attachment's enrichment state — arch §8.4 rule 3 and §9.6 rule 7;
// build item 3.5, split out of ./reprocess.ts.
//
// `events.enrichment_state` is the migration's own vocabulary — none_needed |
// pending | ready | failed | skipped — and this module is the only place it is
// derived. Two rules do all the work here:
//
//   * READY, FAILED AND SKIPPED ARE ALL RESOLVED (§8.4 rule 3). Only `pending`
//     holds pass 2 back. An episode is complete when nothing is still being
//     read, NOT when everything was read successfully — otherwise one dead
//     voice note strands it at ◍ forever.
//   * A PLACEHOLDER IS NEVER EMPTY (§9.6 rule 7). An unread attachment is
//     UNKNOWN content, never absent content and never an acknowledgement, so
//     every state has words: "[image, description pending]" before the caption
//     lands, "[voice note, unreadable]" after whisper gave up.
//
// Which lifecycle column a kind is read through is §10.1's routing, borrowed
// from `media/batch.ts` rather than restated — a `skip` verdict there (a
// sticker with read_all_media off, a sub-2 s clip) is `skipped` here, and the
// countdown must agree with the queue about it or it would wait forever.
// ===========================================================================

import { enrichmentRoute } from "../media/batch.js";
import type { PackEvent } from "../wire/pack.js";

// ---------------------------------------------------------------------------
// One attachment's state — `events.enrichment_state`
// ---------------------------------------------------------------------------

/** The migration's vocabulary, verbatim: none_needed | pending | ready | failed | skipped. */
export type EnrichmentState = "none_needed" | "pending" | "ready" | "failed" | "skipped";

export interface AttachmentRow {
  id: string;
  kind: string | null;
  media_desc_status: string | null;
  media_description: string | null;
  transcript_status: string | null;
  transcript: string | null;
  link_scrape_status: string | null;
  link_scraped_text: string | null;
  link_title: string | null;
  link_url: string | null;
  media_seconds: number | null;
  text: string | null;
  ts: string | null;
  stream_id: string | null;
  actor_id: string | null;
}

export const ATTACHMENT_COLUMNS = `id, kind, media_desc_status, media_description, transcript_status,
                            transcript, link_scrape_status, link_scraped_text, link_title,
                            link_url, media_seconds, text, ts, stream_id, actor_id`;

/** Which lifecycle column reads this kind — §10.1's routing, not a guess here. */
function lifecycleOf(row: AttachmentRow): {
  channel: "caption" | "transcript" | "scrape" | null;
  status: string | null;
  text: string | null;
} {
  const route = enrichmentRoute({
    kind: row.kind,
    seconds: row.media_seconds,
    url: row.link_url,
  });
  switch (row.kind) {
    case "image":
    case "sticker":
    case "video":
    case "document":
      return {
        channel: "caption",
        status: route.step === "skip" ? "skipped" : row.media_desc_status,
        text: row.media_description,
      };
    case "audio":
    case "voice":
    case "ptt":
      return {
        channel: "transcript",
        status: route.step === "skip" ? "skipped" : row.transcript_status,
        text: row.transcript,
      };
    case "link":
      return {
        channel: "scrape",
        status: row.link_scrape_status,
        text: row.link_scraped_text ?? row.link_title,
      };
    default:
      return { channel: null, status: null, text: null };
  }
}

/**
 * What this attachment is to the countdown. `null` status on a real attachment
 * means the enrichment has not been attempted yet — pending, not resolved.
 *
 * Only `pending` blocks pass 2. Ready, failed and skipped are all RESOLVED
 * (§8.4 rule 3): the episode is complete when nothing is still being read, not
 * when everything was read successfully.
 */
export function stateOf(row: AttachmentRow): EnrichmentState {
  const life = lifecycleOf(row);
  if (life.channel === null) return "none_needed";
  switch (life.status) {
    case "done":
      return "ready";
    case "error":
      return "failed";
    case "skipped":
    case "unsupported":
      return "skipped";
    case "pending":
    case null:
    default:
      return "pending";
  }
}

/** The reader's word for this kind of attachment. */
function noun(kind: string | null): string {
  switch (kind) {
    case "sticker":
      return "sticker";
    case "video":
      return "video";
    case "document":
      return "document";
    case "audio":
    case "voice":
    case "ptt":
      return "voice note";
    case "link":
      return "link";
    default:
      return "image";
  }
}

/** What "pending" reads as for this kind — §8.4's own two examples, generalised. */
function pendingWord(kind: string | null): string {
  switch (kind) {
    case "audio":
    case "voice":
    case "ptt":
      return "transcription pending";
    case "link":
      return "preview pending";
    default:
      return "description pending";
  }
}

/**
 * §9.6 rule 7: "Placeholders are explicit in every prompt — an unread
 * attachment is UNKNOWN content, never absent content, never an
 * acknowledgement." Pass 1 sends the pending form; pass 2 sends the real text,
 * or the unreadable form when the enrichment failed or was skipped.
 */
export function placeholderFor(state: EnrichmentState, kind: string | null): string {
  const word = noun(kind);
  switch (state) {
    case "pending":
      return `[${word}, ${pendingWord(kind)}]`;
    case "failed":
      return `[${word}, unreadable]`;
    case "skipped":
      return `[${word}, not read]`;
    default:
      return `[${word}]`;
  }
}

/**
 * The line an event contributes to a prompt: its own text plus the attachment,
 * readable or placeholder. Never empty for an attachment — that is the whole
 * point of a placeholder.
 */
function eventText(row: AttachmentRow, state: EnrichmentState): string {
  const own = (row.text ?? "").trim();
  if (state === "none_needed") return own;
  const life = lifecycleOf(row);
  const enriched = state === "ready" ? (life.text ?? "").trim() : "";
  const media = enriched === "" ? placeholderFor(state, row.kind) : `[${noun(row.kind)}: ${enriched}]`;
  return own === "" ? media : `${own} ${media}`;
}

export function toPackEvent(row: AttachmentRow, state: EnrichmentState, fallbackStream: string): PackEvent {
  const text = eventText(row, state);
  return {
    id: row.id,
    streamId: row.stream_id ?? fallbackStream,
    at: row.ts ?? "",
    speakerId: row.actor_id ?? "self",
    ...(text === "" ? {} : { text }),
  };
}
