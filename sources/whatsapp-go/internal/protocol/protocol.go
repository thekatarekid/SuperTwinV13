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

type errorMsg struct {
	T       string `json:"t"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal"`
}

// --- Inbound command (worker -> daemon, one per stdin line) ---

// Command is a single worker->daemon command. Unknown cmd values are ignored.
type Command struct {
	Cmd   string `json:"cmd"`
	Range Range  `json:"range,omitempty"`
}
