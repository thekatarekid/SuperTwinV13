// ===========================================================================
// [CODE] The WhatsApp source manifest (arch §2.1, §2.2; build item 1.1).
//
// This file is the ONLY place the word "whatsapp" is allowed to decide
// anything. Everything downstream — segmentation windows, backfill direction,
// which identities the resolver may mint, what a session may bridge on — reads
// it off this object rather than branching on the source name.
//
// WhatsApp is family 1 of arch §2: turn-taking, many actors, 10²–10³ events a
// day. Every chat is a CONVERSATION; there is no lane in WhatsApp that is a
// document, a feed, a sensor or a bounded record, so `stream_kind_of` is
// honestly constant rather than pretending to dispatch.
// ===========================================================================

import type { SourceEvent } from "../types.js";
import { selfIdentityValue } from "../../db/ingest.js";
import type { SourceManifest, StreamKind, StreamRef } from "../registry.js";

/** The id every WhatsApp row, key and route is namespaced by. */
export const WHATSAPP_SOURCE_ID = "whatsapp";

// ---- Segmentation constants (build item 1.1) ------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** 1:1 silence gap. Two people tolerate a longer pause before a thread is over. */
export const GAP_MS_DM = 6 * HOUR;
/** Group silence gap — a group refills faster, so it breaks sooner. */
export const GAP_MS_GROUP = 4 * HOUR;
/** A participant shift below this gap is turn-taking, not a new session. */
export const SHIFT_MIN_GAP_MS = 1 * HOUR;
/** Hard size cap on one session. */
export const SIZE_CAP_EVENTS = 40;
/**
 * ~6k tokens of text. The cap is measured in CHARS because that is what the
 * segmenter can count without a tokenizer; 4 chars/token is the ratio the
 * packer measures on this corpus, so 6k tokens ≈ 24k chars.
 */
export const SIZE_CAP_CHARS = 24_000;
/** How long a live tail must be quiet before the session is worth judging. */
export const DEBOUNCE_MS = 45 * MINUTE;

/**
 * The self JID, or null before pairing.
 *
 * Resolved LAZILY on every call, never captured: the daemon does not know who
 * "me" is until the phone pairs, and a manifest read at boot would freeze a
 * null into the one binding that must never be wrong.
 */
export function selfJid(): string | null {
  return selfIdentityValue(WHATSAPP_SOURCE_ID);
}

/**
 * Every WhatsApp lane is a conversation (§2.1). DMs, groups, broadcast lists
 * and the self-chat all turn-take between actors; none of them is a revision
 * stream, an activity log, a sensor or a record with its own start and end.
 */
function streamKindOf(_stream: StreamRef): StreamKind {
  return "conversation";
}

export const WHATSAPP_MANIFEST: SourceManifest<SourceEvent> = {
  source_id: WHATSAPP_SOURCE_ID,
  display_name: "WhatsApp",

  stream_kind_of: streamKindOf,

  // Many actors per lane, so participant shift is a real boundary signal.
  actor_model: "multi_actor",

  // §2.2 note 4 — how "me" appears here, and the only binding for the canonical
  // self entity.
  self_identity: { kind: "jid", value_getter: selfJid },

  // A WhatsApp lane is keyed by the chat JID; its label is the chat name the
  // daemon learned (it re-emits a better one later, which is why the label is a
  // function of the event rather than a string frozen at first sight).
  streams: {
    key: (ev) => ev.stream_ext_id,
    label: (ev) => ev.stream_ext_id,
  },

  // A WhatsApp actor arrives as a JID; the phone number falls out of the user
  // half of it. Nothing else about a contact is emitted by this source.
  identities_emitted: ["jid", "phone"],

  capabilities: {
    backfill: true,
    live: true,
    media: true,
    // WhatsApp has no revision history: an edit replaces the body, it does not
    // add a version.
    revisions: false,
    edits: true,
    deletion: true,
    // §2.2 note 1 + build item 1.1: history sync is DRIVEN newest-page-first.
    // whatsmeow hands its pages back oldest-first, so the descending cohorts are
    // assembled on our side (see ../backfill-order.ts) — the manifest states the
    // order the core is served, not the order the daemon happens to speak in.
    backfill_order: "desc",
    backfill_paged: true,
    page_hint_events: 500,
  },

  segmentation: {
    gap_ms: GAP_MS_DM,
    gap_ms_by_stream: { dm: GAP_MS_DM, group: GAP_MS_GROUP },
    size_cap_events: SIZE_CAP_EVENTS,
    size_cap_chars: SIZE_CAP_CHARS,
    day_boundary: true,
    participant_shift: true,
    shift_min_gap_ms: SHIFT_MIN_GAP_MS,
    debounce_ms: DEBOUNCE_MS,
  },

  enrichment: {
    kinds: ["image", "video", "audio", "link", "doc"],
    // §2 fact 4 — two orders of magnitude between a link scrape and a video, and
    // the scheduler plans around it instead of blocking on the slowest one.
    expected_latency_ms_p50: {
      link: 1_000,
      image: 5_000,
      doc: 5_000,
      audio: 25_000,
      video: 60_000,
    },
  },

  // 10²–10³ events/day is inside what the segmenter handles directly, so nothing
  // is dropped before segmentation. (`none` is only illegal for `ambient`.)
  salience: { prefilter: "none" },

  bridge_keys: ["url", "phone", "email", "media_work_id", "order_id"],
};
