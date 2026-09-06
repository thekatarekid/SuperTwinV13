// Package protocol defines the NDJSON wire protocol between the Go whatsmeow
// daemon and the Node worker, exactly per docs/PHASE1_CONTRACT.md §1/§2/§3.
//
// Every line on stdout is one JSON object with a discriminator field `t`
// (daemon -> worker). Every line on stdin is one JSON object with a
// discriminator field `cmd` (worker -> daemon). Human/diagnostic logging
// NEVER goes to stdout; it goes to stderr only.
//
// All timestamps are ISO-8601 UTC with milliseconds (e.g. 2026-07-02T12:34:56.789Z).
package protocol

import (
	"time"
)

// TimeFormat is ISO-8601 UTC with millisecond precision, per the contract.
const TimeFormat = "2006-01-02T15:04:05.000Z07:00"

// FormatTime renders t as an ISO-8601 UTC millisecond timestamp.
func FormatTime(t time.Time) string {
	return t.UTC().Format(TimeFormat)
}

// ParseTime is the inverse of FormatTime for values arriving on the INBOUND
// (worker -> daemon) side. RFC3339 parsing accepts an optional fractional part,
// so it reads both our own TimeFormat output and a plain second-precision
// timestamp; the zero time comes back on anything else.
func ParseTime(s string) (time.Time, error) {
	return time.Parse(time.RFC3339, s)
}

// State is the connection/lifecycle state enum (status.state), contract §1.
type State string

const (
	StateStarting     State = "starting"
	StateNeedPairing  State = "need_pairing"
	StatePairing      State = "pairing"
	StateConnected    State = "connected"
	StateSyncing      State = "syncing"
	StateOnline       State = "online"
	StateReconnecting State = "reconnecting"
	StateLoggedOut    State = "logged_out"
	StateError        State = "error"
)

// Range is the backfill range enum, contract §3.
type Range string

const (
	Range24h  Range = "24h"
	Range3d   Range = "3d"
	Range7d   Range = "7d"
	Range30d  Range = "30d"
	Range90d  Range = "90d"
	Range180d Range = "180d"
	Range1y   Range = "1y"
	Range2y   Range = "2y"
	Range3y   Range = "3y"
	Range4y   Range = "4y"
	Range5y   Range = "5y"
	RangeAll  Range = "all"
)

// Kind is the event kind enum, contract §3.
type Kind string

const (
	KindMessage      Kind = "message"
	KindImage        Kind = "image"
	KindVideo        Kind = "video"
	KindAudio        Kind = "audio"
	KindDocument     Kind = "document"
	KindSticker      Kind = "sticker"
	KindLocation     Kind = "location"
	KindLiveLocation Kind = "live_location"
	KindContact      Kind = "contact"
	KindRevoked      Kind = "revoked"
	KindReaction     Kind = "reaction"
	KindPoll         Kind = "poll"
	KindPollVote     Kind = "poll_vote"
	KindCall         Kind = "call"
	KindSystem       Kind = "system"
)

// --- Outbound message envelopes (daemon -> worker, one per stdout line) ---
// Each has a `t` discriminator. We use distinct structs so the JSON shape is
// exactly the contract's; the writer sets `t`.

// Media is the media descriptor embedded in an Event (null when no media).
// Everything below SHA256 is optional and omitted when the proto did not carry
// it (docs/rich-media-spec.md §1).
type Media struct {
	Path     string `json:"path"`
	Mime     string `json:"mime"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`

	// ThumbPath is the proto's JPEGThumbnail written next to Path. For a video
	// it is the only frame obtainable without shipping ffmpeg.
	ThumbPath string `json:"thumb_path,omitempty"`
	Width     int    `json:"width,omitempty"`
	Height    int    `json:"height,omitempty"`
	Seconds   int    `json:"seconds,omitempty"` // audio + video duration
	Pages     int    `json:"pages,omitempty"`   // document page count
	Caption   string `json:"caption,omitempty"`
	Voice     bool   `json:"voice,omitempty"`    // PTT / voice note
	Animated  bool   `json:"animated,omitempty"` // animated sticker or gif-playback video
}

// Link is the link-preview reference on an Event (v3-spec §3). URL is the only
// field a plain-text message yields; a real ExtendedTextMessage preview fills
// the rest. ThumbPath is the preview's JPEGThumbnail written under the media
// dir — there is no full media behind a link preview, only those bytes.
type Link struct {
	URL         string `json:"url"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	ThumbPath   string `json:"thumb_path,omitempty"`
	PreviewType string `json:"preview_type,omitempty"`
}

// ReplyTo is the quoted-message reference on an Event (contract §R5.4). It is
// set when a message quotes another (whatsmeow ContextInfo). Null otherwise.
type ReplyTo struct {
	ExternalID string `json:"external_id"`  // "<canonicalChat>/<StanzaID>"
	Text       string `json:"text"`         // extracted text of the quoted message
	ActorExtID string `json:"actor_ext_id"` // canonical JID of the quoted sender
}

// Event is the canonical event payload, contract §3 (+ §R5.3/§R5.4 additions).
type Event struct {
	ExternalID   string `json:"external_id"`    // "<chatJID>/<messageID>"
	ChannelExtID string `json:"channel_ext_id"` // -> channels.source_ext_id
	ActorExtID   string `json:"actor_ext_id"`   // -> actors.source_ext_id
	TS           string `json:"ts"`             // ISO-8601 UTC ms
	Kind         Kind   `json:"kind"`
	Text         string `json:"text"`
	Media        *Media `json:"media"` // null when no media
	FromMe       bool   `json:"from_me"`
	// ReplyToExternalID is set ONLY for kind:"reaction" (contract §R5.3): it is
	// the TARGET message's external_id ("<canonicalChat>/<targetMsgID>"). Text
	// carries the emoji ("" = reaction removed). Omitted for non-reaction events.
	ReplyToExternalID string `json:"reply_to_external_id,omitempty"`
	// ReplyTo is the quoted-message reference for a normal reply (contract §R5.4).
	// Null when the message does not quote another.
	ReplyTo *ReplyTo `json:"reply_to"`
	// Link is the URL the message carries, with whatever preview metadata came
	// with it (v3-spec §3). Null when the message carries no URL.
	Link *Link `json:"link"`
	// EditOfExternalID / RevokeOfExternalID name the message this one replaces or
	// deletes, in the same "<canonicalChat>/<stanzaID>" shape as ExternalID so
	// they join directly against the stored event (rich-media-spec §2/§5).
	EditOfExternalID   string   `json:"edit_of_external_id,omitempty"`
	RevokeOfExternalID string   `json:"revoke_of_external_id,omitempty"`
	IsForwarded        bool     `json:"is_forwarded,omitempty"`
	MentionedExtIDs    []string `json:"mentioned_ext_ids,omitempty"`
	// IsHistorical marks an event that came out of a history-sync batch instead of
	// arriving live (v4-spec §4b). Nothing on the wire distinguishes the two, so
	// without it an import looks like a burst of live traffic and the worker's
	// media queue degenerates to one row per batch. Absent means live, which is
	// also what an older daemon means.
	IsHistorical bool           `json:"is_historical,omitempty"`
	Raw          map[string]any `json:"raw"`
}

// Channel is the canonical channel payload, contract §3.
type Channel struct {
	SourceExtID string `json:"source_ext_id"` // "<chatJID>"
	Name        string `json:"name"`
	Kind        string `json:"kind"` // "dm" | "group"
	// IsBusiness marks a WhatsApp Business or official account, so media on the
	// chat can be gated behind media.business_enabled (v3-spec §5). Always
	// written so the worker never has to guess at an absent field.
	IsBusiness bool `json:"is_business"`
}

// Actor is the canonical actor payload, contract §3.
type Actor struct {
	SourceExtID string `json:"source_ext_id"` // "<senderJID>"
	DisplayName string `json:"display_name"`
	Handle      string `json:"handle"`
	IsSelf      bool   `json:"is_self"`
}

// Outbound line types. Each embeds a `t` set by the Writer helpers.

type readyMsg struct {
	T string `json:"t"`
}

type statusMsg struct {
	T        string `json:"t"`
	State    State  `json:"state"`
	Detail   string `json:"detail,omitempty"`
	JID      string `json:"jid,omitempty"`
	PushName string `json:"push_name,omitempty"`
}

type qrMsg struct {
	T        string `json:"t"`
	Code     string `json:"code"`
	TimeoutS int    `json:"timeout_s"`
}

type pairedMsg struct {
	T        string `json:"t"`
	JID      string `json:"jid"`
	PushName string `json:"push_name"`
}

type channelMsg struct {
	T       string  `json:"t"`
	Channel Channel `json:"channel"`
}

type actorMsg struct {
	T     string `json:"t"`
	Actor Actor  `json:"actor"`
}

type eventMsg struct {
	T     string `json:"t"`
	Event Event  `json:"event"`
}

// Progress is the backfill progress payload, contract §1.
type progressMsg struct {
	T          string `json:"t"`
	Phase      string `json:"phase"` // "backfill" | "live"
	ChatsDone  int    `json:"chats_done"`
	ChatsTotal int    `json:"chats_total"`
	Messages   int    `json:"messages"`
	Done       bool   `json:"done"`
	Range      Range  `json:"range,omitempty"`
}

type backfillCompleteMsg struct {
	T        string `json:"t"`
	Range    Range  `json:"range"`
	Chats    int    `json:"chats"`
	Messages int    `json:"messages"`
}

// HistorySync reports what ONE processed HistorySync payload actually carried,
// contract §1. It is the wire form of the per-payload log line, emitted so the
// worker can tell a bootstrap-only session from a full re-upload from EVIDENCE
// rather than from the shape of what happened to land in its DB.
//
// The counters partition the payload: MessagesSeen ==
// MessagesEmitted + MessagesFiltered, where MessagesFiltered folds together the
// two ways a message is dropped (outside the requested range, or unparseable /
// unmappable). MessagesInRange sits between Seen and Emitted: it counts what
// survived the range filter, so Emitted < InRange means messages were in range
// but could not be mapped.
type HistorySync struct {
	// SyncType is whatsmeow's enum name (INITIAL_BOOTSTRAP / FULL / RECENT /
	// ON_DEMAND / …), compared only as a string so a new type needs no release.
	SyncType string `json:"sync_type"`
	// Progress is WhatsApp's own 0-100 progress, omitted when it sends none.
	Progress *int `json:"progress,omitempty"`
	// Chats is every conversation the payload carried; ChatsInRange those that
	// survived the chat-level range filter.
	Chats        int `json:"chats"`
	ChatsInRange int `json:"chats_in_range"`
	// MessagesSeen counts messages before any filter.
	MessagesSeen int `json:"messages_seen"`
	// MessagesInRange survived the range filter (mapping may still fail).
	MessagesInRange int `json:"messages_in_range"`
	// MessagesEmitted reached the worker.
	MessagesEmitted int `json:"messages_emitted"`
	// MessagesFiltered were dropped by the range filter or by mapping.
	MessagesFiltered int `json:"messages_filtered"`
	// OnDemand marks a page fetched by "Extend history" rather than a
	// server-pushed batch.
	OnDemand bool `json:"on_demand"`
}

// historySyncMsg embeds HistorySync so the counters land FLAT on the wire
// (t + the fields), which is the shape the worker's handler reads.
type historySyncMsg struct {
	T string `json:"t"`
	HistorySync
}

type errorMsg struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
}

// sendResultMsg reports the outcome of ONE `send_message` command (P0.6). OK
// is true iff the message actually left through the engine; ExternalID is the
// sent message's "<chatJID>/<messageID>" (so the worker can join the echo of
// its own send against the stored event), empty on failure. Detail carries a
// human-readable reason on failure.
type sendResultMsg struct {
	T          string `json:"t"`
	OK         bool   `json:"ok"`
	ExternalID string `json:"external_id,omitempty"`
	Detail     string `json:"detail,omitempty"`
}

// RangeCount is what ONE import window would deliver: the chats whose most
// recent activity falls inside the window and the messages inside it (the two
// contract §4 filters, applied exactly as an import would apply them).
type RangeCount struct {
	Chats    int `json:"chats"`
	Messages int `json:"messages"`
}

// RangeCounts answers a `count_range` command (V6 P1 S1.5, backlog T4-7). It is
// MEASURED over the history the daemon has actually received from WhatsApp —
// the post-pairing HistorySync batches held in the pre-range buffer plus any
// already processed this process — never estimated. The connect flow shows these
// numbers per window before the user confirms, so the card can say "38,412
// messages in 214 chats" and mean it.
//
// The honesty caveats ride alongside: SyncTypes says whether WhatsApp has sent
// only the INITIAL_BOOTSTRAP so far (counts will still rise) or bulk FULL
// chunks; OldestTS is how far back what arrived actually reaches, so "everything"
// can be labelled as "everything WhatsApp has sent", not everything on the phone.
type RangeCounts struct {
	// Counts keyed by Range ("24h" … "all").
	Counts map[Range]RangeCount `json:"counts"`
	// Chats / Messages seen across every history payload so far (noise chats
	// excluded), before any range filter — equals Counts["all"].
	Chats    int `json:"chats"`
	Messages int `json:"messages"`
	// OldestTS / NewestTS bound the history received, ISO-8601; empty when none.
	OldestTS string `json:"oldest_ts,omitempty"`
	NewestTS string `json:"newest_ts,omitempty"`
	// BufferedBatches is how many HistorySync payloads are still held unprocessed
	// (no range installed yet); Batches is every payload seen this process.
	BufferedBatches int `json:"buffered_batches"`
	Batches         int `json:"batches"`
	// SyncTypes lists the whatsmeow sync-type names seen (INITIAL_BOOTSTRAP,
	// FULL, RECENT, …), sorted, so the worker can tell bootstrap-only from bulk.
	SyncTypes []string `json:"sync_types"`
	// RangeInstalled is true once Import/SetRange has confirmed a window; from
	// then on history flows through instead of buffering.
	RangeInstalled bool  `json:"range_installed"`
	Range          Range `json:"range,omitempty"`
	// PendingLive counts live messages held back because no window is confirmed
	// yet (S1.5: no live ingest between pairing and confirm).
	PendingLive int `json:"pending_live"`
}

type rangeCountsMsg struct {
	T string `json:"t"`
	RangeCounts
}

// --- Inbound command (worker -> daemon, one per stdin line) ---

// Anchor is ONE chat's oldest-known message, supplied by the worker on the
// `seed_anchors` command. It is the starting point the daemon paginates BACKWARD
// from when it asks WhatsApp for older history.
//
// The four fields are exactly — and only — what whatsmeow's
// BuildHistorySyncRequest puts on the wire (send.go: ChatJID, OldestMsgID,
// OldestMsgFromMe, OldestMsgTimestampMS), so an anchor is complete iff all four
// are present.
//
// The daemon cannot derive these itself: its own store is whatsmeow's sqlstore,
// which has no message table at all (whatsmeow_message_secrets carries
// chat/sender/message_id but NO timestamp and NO from_me), and the in-memory
// anchor map is rebuilt only from messages that flow through THIS process. The
// worker's events table is therefore the only durable source of "oldest message
// we actually hold per chat" — and it is the authority on what was ingested,
// which is precisely what pagination must resume from.
type Anchor struct {
	// ChatJID is the canonical chat JID the daemon emitted as
	// channel_ext_id / the "<chat>" half of external_id.
	ChatJID string `json:"chat_jid"`
	// MsgID is the WhatsApp message id — the "<id>" half of external_id, NOT the
	// full external_id.
	MsgID string `json:"msg_id"`
	// FromMe marks an anchor message the user sent.
	FromMe bool `json:"from_me"`
	// TS is the anchor message's timestamp, ISO-8601 (see ParseTime).
	TS string `json:"ts"`
}

// Command is a single worker->daemon command. Unknown cmd values are ignored.
type Command struct {
	Cmd   string `json:"cmd"`
	Range Range  `json:"range,omitempty"`
	// Anchors carries the `seed_anchors` payload (worker -> daemon). Empty for
	// every other command.
	Anchors []Anchor `json:"anchors,omitempty"`

	// --- send_message payload (P0.6, tightened by V6 P1 S4.5). The daemon
	// HARD-REFUSES a send_message whose ApprovalToken is absent, unsigned,
	// signed under another key, expired, bound to a different recipient/text,
	// or already seen by this process: enforcement is code, not prompt
	// (spec §2.13). The worker mints and consumes tokens in its single-use
	// token table before ever writing this command; the daemon's check
	// (internal/daemon/sendgate.go) is a second, INDEPENDENT gate that needs no
	// access to that table — it verifies the tap's own signature.
	To            string `json:"to,omitempty"`
	Text          string `json:"text,omitempty"`
	ApprovalToken string `json:"approval_token,omitempty"`
}
