// ===========================================================================
// [CODE] The Calendar source manifest (arch §2.1, §2.2; build item 5.1).
//
// Phase 5 is the thesis proof: a second source is TWO MANIFESTS AND NO CORE
// CHANGES. This file is the ONLY place the word "calendar" is allowed to
// decide anything — everything downstream reads this object exactly the way it
// reads the WhatsApp one, through the same registry, with zero generic-layer
// edits.
//
// Calendar is family 2 of arch §2 (Notes · Reminders · Calendar): bounded
// records, 10⁰–10¹ events a day, one-to-many actors. Every calendar lane is a
// BOUNDED stream (§2.1): the record has its own start and end, the session IS
// the record, and no gap/cap inference applies — so `stream_kind_of` is
// honestly constant, exactly like WhatsApp's, just with a different answer.
// ===========================================================================

import type { SourceEvent } from "../types.js";
import { selfIdentityValue } from "../../db/ingest.js";
import type { SourceManifest, StreamKind, StreamRef } from "../registry.js";

/** The id every calendar row, key and route is namespaced by. */
export const CALENDAR_SOURCE_ID = "calendar";

// ---- Segmentation constants (build item 5.1) ------------------------------
//
// §2.1: for a BOUNDED stream "session = the record. No inference. Caps do not
// apply." The numbers below exist because the manifest contract requires
// positive values (validation, §2.2 note 2), and they are chosen so that even
// if a bounded lane were ever run through the gap segmenter by mistake, each
// record would still land alone: one event per session, no merging.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Irrelevant for bounded lanes; a day keeps adjacent records apart anyway. */
export const GAP_MS = 24 * HOUR;
/** Session = the record → exactly one event per session. */
export const SIZE_CAP_EVENTS = 1;
/** One record's text (summary + description) never approaches this. */
export const SIZE_CAP_CHARS = 24_000;
/** No participant-shift inference on a bounded lane. */
export const SHIFT_MIN_GAP_MS = 1 * HOUR;
/** A record is complete on arrival; nothing to debounce beyond a beat. */
export const DEBOUNCE_MS = 1 * MINUTE;

/**
 * The self email, or null before the adapter has learned it.
 *
 * Resolved LAZILY on every call, never captured — same rule as WhatsApp's
 * selfJid(): the identity is persisted by ingestion when the adapter emits the
 * self actor, and a manifest read at boot must not freeze a null into the one
 * binding that must never be wrong (§2.2 note 4).
 */
export function selfEmail(): string | null {
  return selfIdentityValue(CALENDAR_SOURCE_ID);
}

/**
 * Every calendar lane is bounded (§2.1, fam 2cal/3cal): an event has DTSTART
 * and DTEND, the session is the record, and there is no lane in a calendar
 * that turn-takes, revises, logs or streams.
 */
function streamKindOf(_stream: StreamRef): StreamKind {
  return "bounded";
}

export const CALENDAR_MANIFEST: SourceManifest<SourceEvent> = {
  source_id: CALENDAR_SOURCE_ID,
  display_name: "Calendar",

  stream_kind_of: streamKindOf,

  // An event names an organizer and attendees — several people per record.
  // (participant_shift stays false below: shift is a CONVERSATION boundary
  // signal and a bounded record has no boundary to infer.)
  actor_model: "multi_actor",

  // §2.2 note 4 — how "me" appears here: as an attendee/organizer email.
  self_identity: { kind: "email", value_getter: selfEmail },

  // A calendar lane is keyed by the calendar's own id (X-WR-CALNAME or the
  // fixture's name); label likewise — the adapter emits a richer Stream upsert
  // with the display name, so these stay honest fallbacks off the event.
  streams: {
    key: (ev) => ev.stream_ext_id,
    label: (ev) => ev.stream_ext_id,
  },

  // Organizer and attendees arrive as emails; nothing else about a person is
  // emitted by this source. This is the [CODE]-rung merge surface with
  // WhatsApp-side emails (Phase 5 acceptance: cross-source identity precision).
  identities_emitted: ["email"],

  capabilities: {
    backfill: true,
    // Fixture/local-ICS driven (build item 5.1): a snapshot file, no live tail.
    live: false,
    media: false,
    // An .ics snapshot carries the latest SEQUENCE only — no revision history,
    // no edit/delete frames. A newer snapshot is a re-backfill; dedupe absorbs it.
    revisions: false,
    edits: false,
    deletion: false,
    // §2.2 note 1: an ICS file has no delivery order at all. The core's
    // descending-cohort buffer re-orders it (adapters/backfill-order.ts) —
    // generic code, untouched, doing exactly what it was built for.
    backfill_order: "unordered",
    backfill_paged: false,
    page_hint_events: 200,
  },

  segmentation: {
    gap_ms: GAP_MS,
    size_cap_events: SIZE_CAP_EVENTS,
    size_cap_chars: SIZE_CAP_CHARS,
    // A multi-day event is still ONE record; midnight does not split it.
    day_boundary: false,
    participant_shift: false,
    shift_min_gap_ms: SHIFT_MIN_GAP_MS,
    debounce_ms: DEBOUNCE_MS,
  },

  enrichment: {
    // The only enrichable payload a calendar event carries is its URL
    // (meeting link, invite page). No media travels through this source.
    kinds: ["link"],
    expected_latency_ms_p50: { link: 1_000 },
  },

  // 10⁰–10¹ events/day (§2 table, family 2) — no prefilter needed, and `none`
  // is legal because no lane is ambient.
  salience: { prefilter: "none" },

  // §2.2 bridge vocabulary: `url` (the meeting link a WhatsApp message also
  // pasted) and `attendee_set` (the same people on the invite and in the
  // group) are the two joins the thesis gate (item 5.4) crosses on; `email`
  // is the identity-level bridge (item 5.3).
  bridge_keys: ["url", "attendee_set", "email"],
};
