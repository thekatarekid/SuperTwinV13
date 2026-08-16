// ===========================================================================
// [CODE] The Contacts source manifest (arch §2.1, §2.2; build item 5.2).
//
// This file is the ONLY place the word "contacts" is allowed to decide
// anything. It is the second manifest the registry has ever seen, and it is
// the Phase-5 thesis made concrete: a new source is a manifest plus an
// adapter, and ZERO generic-layer edits.
//
// Contacts is family 2 of arch §2 (Notes · Reminders · Calendar row): a
// handful of records a day, one actor — me, the owner of the address book.
// A contact card is an artifact that gets revised in sittings, so every lane
// is a DOCUMENT stream: there is no turn-taking, no feed, no sensor and no
// record with its own start and end.
//
// What this source is FOR, graph-wise: a card carries normalised phones and
// emails next to a human name. Those are exactly the two identity kinds rung
// ② of the resolution ladder (worker/src/entities/) may join across sources
// at [CODE], which is what lets a Contacts import land on the same person a
// WhatsApp import minted — with zero model calls.
// ===========================================================================

import { selfIdentityValue } from "../../db/ingest.js";
import type { SourceManifest, StreamKind, StreamRef } from "../registry.js";
import type { SourceEvent } from "../types.js";

/** The id every contacts row, key and identity is namespaced by. */
export const CONTACTS_SOURCE_ID = "contacts";

/** The one lane an address book has. */
export const CONTACTS_STREAM_EXT_ID = "addressbook";

// ---- Segmentation constants ------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Edit-burst gap (§2.1 DOCUMENT): card saves within half an hour are one
 * working sitting on the address book; a longer pause ends it.
 */
export const GAP_MS = 30 * MINUTE;
/** A sitting that touches this many cards is sealed regardless of gaps. */
export const SIZE_CAP_EVENTS = 100;
/** Card summaries are tiny; this cap exists to satisfy the contract, not to bite. */
export const SIZE_CAP_CHARS = 24_000;
/** Meaningless for a single-actor source, but the field must be positive. */
export const SHIFT_MIN_GAP_MS = 1 * HOUR;
/** How long the tail must be quiet before a sitting is worth judging. */
export const DEBOUNCE_MS = 5 * MINUTE;

/**
 * How "me" appears in this source: the owner's card's primary email, learned
 * at import and persisted under `source.contacts.self_identity`. Resolved
 * LAZILY on every call, never captured — before the first import it is null,
 * and a manifest read at boot must not freeze that null in.
 */
export function selfEmail(): string | null {
  return selfIdentityValue(CONTACTS_SOURCE_ID);
}

/**
 * Every contacts lane is a document stream (§2.1). A card revision is an edit
 * to one artifact by one author; the honest constant, exactly like WhatsApp's.
 */
function streamKindOf(_stream: StreamRef): StreamKind {
  return "document";
}

export const CONTACTS_MANIFEST: SourceManifest<SourceEvent> = {
  source_id: CONTACTS_SOURCE_ID,
  display_name: "Contacts",

  stream_kind_of: streamKindOf,

  // One actor — me. Participant-shift boundaries are meaningless here
  // (arch §2 fact 3), and the manifest says so instead of pretending.
  actor_model: "single_actor",

  // §2.2 note 4 — the canonical self binds through the owner's email.
  self_identity: { kind: "email", value_getter: selfEmail },

  // The whole address book is one lane; a card event carries it as its
  // stream_ext_id, so the key function is the same shape WhatsApp's is.
  streams: {
    key: (ev) => ev.stream_ext_id,
    label: () => "Address Book",
  },

  // A card emits normalised phones and emails — the ONLY two kinds allowed to
  // join sources at [CODE] (entities/identities.ts CROSS_SOURCE_KINDS) — plus
  // its own UID as a source-scoped account_id that never crosses a source.
  identities_emitted: ["phone", "email", "account_id"],

  capabilities: {
    backfill: true,
    // The fixture-driven adapter has no live push; a real device sync would.
    live: false,
    media: false,
    // A card save replaces the card in place, like a WhatsApp edit.
    revisions: false,
    edits: true,
    deletion: true,
    // An address book has no timeline: cards arrive as a set, and REV
    // timestamps are optional. `unordered` is the honest declaration — the
    // scheduler buffers and re-orders into descending cohorts itself
    // (../backfill-order.ts), exactly as §2.2 note 1 prescribes.
    backfill_order: "unordered",
    backfill_paged: false,
    page_hint_events: 200,
  },

  segmentation: {
    gap_ms: GAP_MS,
    size_cap_events: SIZE_CAP_EVENTS,
    size_cap_chars: SIZE_CAP_CHARS,
    day_boundary: false,
    // single_actor + participant_shift:true fails validation — correctly.
    participant_shift: false,
    shift_min_gap_ms: SHIFT_MIN_GAP_MS,
    debounce_ms: DEBOUNCE_MS,
  },

  // A card is text through and through; nothing to caption, scrape or hear.
  enrichment: {
    kinds: [],
    expected_latency_ms_p50: {},
  },

  // 10⁰–10¹ events/day. No gate needed (`none` is only illegal for ambient).
  salience: { prefilter: "none" },

  // What a contacts object may bridge on (§2.2): the same two exact keys its
  // identities join on. No urls, no order ids, no attendee sets here.
  bridge_keys: ["phone", "email"],
};
