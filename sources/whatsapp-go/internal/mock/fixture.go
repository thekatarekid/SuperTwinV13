// Package mock provides a synthetic, in-memory WhatsApp fixture that drives
// the exact same NDJSON protocol as the real daemon, per contract §9. It lets
// the whole worker<->daemon pipeline (pairing, backfill, range-extend, live,
// dedupe, Inbox, FTS, media) be tested in CI with zero WhatsApp account.
package mock

import (
	"encoding/json"
	"os"
	"time"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// FixtureChat is a chat definition in a mock fixture file.
type FixtureChat struct {
	JID  string `json:"jid"`
	Name string `json:"name"`
	Kind string `json:"kind"` // "dm" | "group"
}

// FixtureActor is a sender definition in a mock fixture file.
type FixtureActor struct {
	JID         string `json:"jid"`
	DisplayName string `json:"display_name"`
	Handle      string `json:"handle"`
	IsSelf      bool   `json:"is_self"`
}

// FixtureMessage is a message definition in a mock fixture file.
// AgoSeconds expresses the message age relative to "now" so a static fixture
// always has a stable position relative to the range windows.
type FixtureMessage struct {
	ChatJID    string `json:"chat_jid"`
	SenderJID  string `json:"sender_jid"`
	MessageID  string `json:"message_id"`
	AgoSeconds int64  `json:"ago_seconds"`
	Kind       string `json:"kind"`
	Text       string `json:"text"`
	FromMe     bool   `json:"from_me"`
	// Media, when set, causes the mock to write a tiny real file to media-dir
	// so downstream /api/media works. MediaBytesB64 is optional; when empty a
	// default 1x1 placeholder is written.
	Media *FixtureMedia `json:"media,omitempty"`
	// ReplyToExternalID, for a kind:"reaction" message, is the TARGET message's
	// external_id ("<chat>/<targetMsgID>"). Text carries the emoji ("" = removal)
	// (contract §R5.3). The mock passes it through verbatim.
	ReplyToExternalID string `json:"reply_to_external_id,omitempty"`
	// ReplyTo, when set, marks this message as a quoted reply and carries the
	// quoted reference (contract §R5.4). Passed through to the event's reply_to.
	ReplyTo *FixtureReplyTo `json:"reply_to,omitempty"`
}

// FixtureReplyTo is the quoted-message reference on a fixture reply message,
// mirroring protocol.ReplyTo (contract §R5.4).
type FixtureReplyTo struct {
	ExternalID string `json:"external_id"`
	Text       string `json:"text"`
	ActorExtID string `json:"actor_ext_id"`
}

// FixtureMedia describes an attached media file to materialize on disk.
type FixtureMedia struct {
	Ext      string `json:"ext"`  // e.g. "jpg"
	Mime     string `json:"mime"` // e.g. "image/jpeg"
	Filename string `json:"filename"`
	BytesB64 string `json:"bytes_b64,omitempty"`
}

// Fixture is the full mock dataset.
type Fixture struct {
	Chats    []FixtureChat    `json:"chats"`
	Actors   []FixtureActor   `json:"actors"`
	Messages []FixtureMessage `json:"messages"`
	// LIDMap maps a LID user-part (the digits before "@lid") to the canonical
	// phone-number JID it belongs to. It lets the mock reproduce the bug-7
	// LID-vs-PN duplicate scenario: a message addressed by "<lid>@lid" and one
	// by "<pn>@s.whatsapp.net" for the SAME person collapse to one channel
	// after canonicalization, exactly like the real daemon's LID store.
	LIDMap map[string]string `json:"lid_map,omitempty"`
	// EmptyInRangeChats is the count of PHANTOM in-range chats that count toward
	// progress.chats_total but deliver NO messages — modeling WhatsApp NOT pushing
	// history for inactive/old chats on a large/entire import (contract §R7.2).
	// When > 0, a mock import's chats_done PLATEAUS below chats_total and the run
	// completes via the simulated quiet window instead of chats_done>=chats_total.
	// Default 0 preserves the existing "chats_done == chats_total" behavior for
	// every current fixture/test.
	EmptyInRangeChats int `json:"empty_in_range_chats,omitempty"`
}

// LoadFixture reads a fixture from a JSON file at path.
func LoadFixture(path string) (*Fixture, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var f Fixture
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	return &f, nil
}

// BuiltinFixture returns the default synthetic fixture: ~3 chats (1 dm, 1
// group, a self chat) spanning ~2h ago to ~200 days ago, with at least one
// media event. Timestamps are expressed as "seconds ago" so filtering is
// deterministic against the range windows.
func BuiltinFixture() *Fixture {
	const (
		selfJID  = "15550000001@s.whatsapp.net"
		momJID   = "15551234567@s.whatsapp.net"
		aliceJID = "15559876543@s.whatsapp.net"
		bobJID   = "15550002222@s.whatsapp.net"
		groupJID = "120363000000000001@g.us"
		// Hrishikesh is reachable by BOTH a phone-number JID (history-sync) and a
		// LID (live). Bug 7: without canonicalization these produce two chats
		// ("Hrishikesh" x2). LIDMap ties the LID to the PN so they collapse.
		hrishPN  = "15557654321@s.whatsapp.net"
		hrishLID = "77771234567@lid"
		// A device-suffixed variant of the self JID (live self message) must also
		// collapse onto the one self chat.
		selfWithDevice = "15550000001:12@s.whatsapp.net"
		// A WhatsApp Business account: its messages are non-plain (template) and
		// its name resolves to a verified business name (contract §R4.2, bug 16).
		bizJID = "15551112222@s.whatsapp.net"
		// An UNSAVED business/OTP sender whose name is NOT in any contact store; it
		// must take its display name from the history-sync Conversation.Name
		// (contract §R6.1). The fixture carries the resolved name directly,
		// mirroring what onHistorySync records from Conversation.Name.
		otpJID = "919538251513@s.whatsapp.net"
		// A DEEP-HISTORY DM (many older messages walking back day by day) so an
		// extend from a narrow to a wide range progressively covers more of it,
		// letting the mock assert extend widens coverage across a multi-message
		// chat toward the wider cutoff (contract §R6.4).
		deepJID = "15553334444@s.whatsapp.net"
		// A chat whose newest message is > 24h old (stale for a 24h range).
		staleJID = "15556667777@s.whatsapp.net"
		// Noise JIDs that MUST be filtered entirely (contract §R4.3, bug 17).
		statusJID     = "status@broadcast"
		newsletterJID = "120363111111111111@newsletter"
		// A MEDIA-ONLY chat whose newest (and only) message is a TEXT-LESS video
		// (contract §R6.5, bug 4): its inbox preview must be a kind label
		// ("🎥 Video"), never empty/"No messages". Recent so a 24h import surfaces it.
		mediaOnlyJID = "15558889999@s.whatsapp.net"
	)

	hours := func(h int64) int64 { return h * 3600 }
	days := func(d int64) int64 { return d * 24 * 3600 }

	return &Fixture{
		LIDMap: map[string]string{
			"77771234567": hrishPN, // LID user-part -> canonical PN
		},
		Chats: []FixtureChat{
			{JID: momJID, Name: "Mom", Kind: "dm"},
			{JID: groupJID, Name: "Weekend Trip", Kind: "group"},
			{JID: selfJID, Name: "You (Notes)", Kind: "dm"},
			// Same person, two addressings — must collapse to ONE channel.
			{JID: hrishPN, Name: "Hrishikesh", Kind: "dm"},
			{JID: hrishLID, Name: "Hrishikesh", Kind: "dm"},
			// A business account (name = verified business name).
			{JID: bizJID, Name: "Acme Support", Kind: "dm"},
			// An unsaved OTP/business sender: name comes from history-sync
			// Conversation.Name (contract §R6.1), recent (in a 24h range).
			{JID: otpJID, Name: "JioHome Offers", Kind: "dm"},
			// A deep-history chat used for the extend-coverage assertion.
			{JID: deepJID, Name: "Subhashree", Kind: "dm"},
			// A media-only chat whose newest message is a text-less video: its inbox
			// preview must be a kind label, not empty (contract §R6.5, bug 4).
			{JID: mediaOnlyJID, Name: "Drone Footage", Kind: "dm"},
			// A STALE chat: its most recent activity is > 24h ago, so it is OUT of a
			// 24h range but IN a wider one. This makes a 24h import PARTIAL (in-range
			// chats < total chats), proving progress.chats_total is the in-range
			// count and that done still fires (contract §R6.3).
			{JID: staleJID, Name: "Old Colleague", Kind: "dm"},
			// Noise chats that must NOT appear as channels or produce events.
			{JID: statusJID, Name: "Status", Kind: "group"},
			{JID: newsletterJID, Name: "Some Channel", Kind: "group"},
		},
		Actors: []FixtureActor{
			{JID: selfJID, DisplayName: "You", Handle: "+15550000001", IsSelf: true},
			{JID: momJID, DisplayName: "Mom", Handle: "+15551234567", IsSelf: false},
			{JID: aliceJID, DisplayName: "Alice", Handle: "+15559876543", IsSelf: false},
			{JID: bobJID, DisplayName: "Bob", Handle: "+15550002222", IsSelf: false},
			{JID: hrishPN, DisplayName: "Hrishikesh", Handle: "+15557654321", IsSelf: false},
			{JID: hrishLID, DisplayName: "Hrishikesh", Handle: "+15557654321", IsSelf: false},
			{JID: bizJID, DisplayName: "Acme Support", Handle: "+15551112222", IsSelf: false},
			{JID: otpJID, DisplayName: "JioHome Offers", Handle: "+919538251513", IsSelf: false},
			{JID: deepJID, DisplayName: "Subhashree", Handle: "+15553334444", IsSelf: false},
			{JID: staleJID, DisplayName: "Old Colleague", Handle: "+15556667777", IsSelf: false},
			{JID: mediaOnlyJID, DisplayName: "Drone Footage", Handle: "+15558889999", IsSelf: false},
		},
		Messages: []FixtureMessage{
			// --- Hrishikesh: LID (live) + PN (history) for the SAME chat/person ---
			{ChatJID: hrishLID, SenderJID: hrishLID, MessageID: "HRI_LIVE_1", AgoSeconds: hours(1),
				Kind: "message", Text: "Live message (LID-addressed)", FromMe: false},
			{ChatJID: hrishPN, SenderJID: hrishPN, MessageID: "HRI_HIST_1", AgoSeconds: days(3),
				Kind: "message", Text: "Older message (PN-addressed)", FromMe: false},
			// Self message with a device suffix (live) must land in the self chat.
			{ChatJID: selfWithDevice, SenderJID: selfWithDevice, MessageID: "SELF_LIVE_1", AgoSeconds: hours(1) - 120,
				Kind: "message", Text: "note from another device", FromMe: true},

			// --- DM with Mom ---
			{ChatJID: momJID, SenderJID: momJID, MessageID: "MOM_0001", AgoSeconds: hours(2),
				Kind: "message", Text: "Are you coming for dinner tonight?", FromMe: false},
			{ChatJID: momJID, SenderJID: selfJID, MessageID: "MOM_0002", AgoSeconds: hours(2) - 600,
				Kind: "message", Text: "Yes! Around 7.", FromMe: true},
			{ChatJID: momJID, SenderJID: momJID, MessageID: "MOM_0003", AgoSeconds: days(20),
				Kind: "image", Text: "Old photo from the garden",
				Media: &FixtureMedia{Ext: "jpg", Mime: "image/jpeg", Filename: "garden.jpg"}},
			{ChatJID: momJID, SenderJID: momJID, MessageID: "MOM_0004", AgoSeconds: days(200),
				Kind: "message", Text: "Happy new year!", FromMe: false},
			// A REACTION on Mom's first message (contract §R5.3, bug 3a): kind
			// reaction, text = emoji, reply_to_external_id -> the TARGET message's
			// external_id. Downstream must attach it to MOM_0001, not show a bubble.
			{ChatJID: momJID, SenderJID: selfJID, MessageID: "MOM_REACT_1", AgoSeconds: hours(2) - 300,
				Kind: "reaction", Text: "👍", FromMe: true,
				ReplyToExternalID: momJID + "/MOM_0001"},

			// --- Group: Weekend Trip ---
			{ChatJID: groupJID, SenderJID: aliceJID, MessageID: "GRP_0001", AgoSeconds: hours(5),
				Kind: "message", Text: "Who's driving on Saturday?", FromMe: false},
			{ChatJID: groupJID, SenderJID: bobJID, MessageID: "GRP_0002", AgoSeconds: hours(4),
				Kind: "message", Text: "I can. Meet at 9am.", FromMe: false},
			// A QUOTED REPLY (contract §R5.4, bug 3b): Alice replies to Bob's
			// GRP_0002, carrying reply_to = {external_id, text, actor_ext_id}.
			{ChatJID: groupJID, SenderJID: aliceJID, MessageID: "GRP_0005", AgoSeconds: hours(4) - 200,
				Kind: "message", Text: "Perfect, see you then!", FromMe: false,
				ReplyTo: &FixtureReplyTo{
					ExternalID: groupJID + "/GRP_0002",
					Text:       "I can. Meet at 9am.",
					ActorExtID: bobJID,
				}},
			{ChatJID: groupJID, SenderJID: selfJID, MessageID: "GRP_0003", AgoSeconds: days(2),
				Kind: "message", Text: "Booked the cabin.", FromMe: true},
			{ChatJID: groupJID, SenderJID: aliceJID, MessageID: "GRP_0004", AgoSeconds: days(45),
				Kind: "location", Text: "Trailhead: 39.5501,-105.7821", FromMe: false},

			// --- Self chat (notes) ---
			{ChatJID: selfJID, SenderJID: selfJID, MessageID: "SELF_0001", AgoSeconds: hours(1),
				Kind: "message", Text: "TODO: renew passport", FromMe: true},
			{ChatJID: selfJID, SenderJID: selfJID, MessageID: "SELF_0002", AgoSeconds: days(90),
				Kind: "message", Text: "Idea: weekend project", FromMe: true},
			// A contentless system/protocol message in the self chat (the "System
			// message" spam, bug 17): must be DROPPED (kind system, empty text).
			{ChatJID: selfJID, SenderJID: selfJID, MessageID: "SELF_SYS_1", AgoSeconds: hours(1) - 30,
				Kind: "system", Text: "", FromMe: true},

			// --- Business chat (bug 16 + §R5.2): a non-plain (template) message
			// carrying REAL body text, from a chat whose name is the VERIFIED
			// business name ("Acme Support") rather than a bare number. The mock
			// stores the already-extracted display text + resolved name; the real
			// daemon extracts the text from TemplateMessage.GetHydratedTemplate()
			// .GetHydratedContentText() and the name from MessageInfo.VerifiedName.
			// The text must be the real body, never "[template message]". ---
			{ChatJID: bizJID, SenderJID: bizJID, MessageID: "BIZ_0001", AgoSeconds: hours(3),
				Kind: "message", Text: "Your order #4821 has shipped. Track it here.", FromMe: false},
			// An OLDER-than-range business message so `extend` (24h -> wider) has
			// something to pull that a narrow range excludes.
			{ChatJID: bizJID, SenderJID: bizJID, MessageID: "BIZ_0002", AgoSeconds: days(10),
				Kind: "message", Text: "Welcome to Acme Support!", FromMe: false},

			// --- Unsaved OTP/business sender (contract §R6.1): recent (in a 24h
			// range) so a narrow import surfaces it; its display name "JioHome
			// Offers" comes from the history-sync Conversation.Name, not a contact
			// store. The text is plain (an OTP), which must NOT become a
			// "[business message]" placeholder (contract §R6.2). ---
			{ChatJID: otpJID, SenderJID: otpJID, MessageID: "OTP_0001", AgoSeconds: hours(2),
				Kind: "message", Text: "Your JioHome OTP is 4821. Valid for 10 minutes.", FromMe: false},

			// --- Deep-history chat "Subhashree" (contract §R6.4): a recent message
			// (in-range for 24h) plus a run of older ones walking back day by day.
			// An extend from 24h to a wider range must progressively cover the older
			// messages up to the wider cutoff. ---
			{ChatJID: deepJID, SenderJID: deepJID, MessageID: "DEEP_R", AgoSeconds: hours(3),
				Kind: "message", Text: "latest from Subhashree", FromMe: false},
			{ChatJID: deepJID, SenderJID: deepJID, MessageID: "DEEP_D2", AgoSeconds: days(2),
				Kind: "message", Text: "two days ago", FromMe: false},
			{ChatJID: deepJID, SenderJID: deepJID, MessageID: "DEEP_D5", AgoSeconds: days(5),
				Kind: "message", Text: "five days ago", FromMe: false},
			{ChatJID: deepJID, SenderJID: deepJID, MessageID: "DEEP_D9", AgoSeconds: days(9),
				Kind: "message", Text: "nine days ago", FromMe: false},
			{ChatJID: deepJID, SenderJID: deepJID, MessageID: "DEEP_D20", AgoSeconds: days(20),
				Kind: "message", Text: "twenty days ago", FromMe: false},
			{ChatJID: deepJID, SenderJID: deepJID, MessageID: "DEEP_D28", AgoSeconds: days(28),
				Kind: "message", Text: "twenty-eight days ago", FromMe: false},

			// --- Stale chat (contract §R6.3): newest activity is 5 days ago, so it
			// is OUT of a 24h range (partial import) but IN a 7d/30d range. ---
			{ChatJID: staleJID, SenderJID: staleJID, MessageID: "STALE_1", AgoSeconds: days(5),
				Kind: "message", Text: "let's catch up sometime", FromMe: false},

			// --- Media-only chat (contract §R6.5, bug 4): a single TEXT-LESS video
			// (empty text), recent so a 24h import surfaces it. Its inbox preview
			// must be the "🎥 Video" kind label, never empty/"No messages". ---
			{ChatJID: mediaOnlyJID, SenderJID: mediaOnlyJID, MessageID: "DRONE_1", AgoSeconds: hours(2),
				Kind: "video", Text: "", FromMe: false,
				Media: &FixtureMedia{Ext: "mp4", Mime: "video/mp4", Filename: "drone.mp4"}},

			// --- Noise that MUST be filtered (bug 17): status feed + newsletter ---
			{ChatJID: statusJID, SenderJID: aliceJID, MessageID: "STATUS_1", AgoSeconds: hours(1),
				Kind: "image", Text: "someone's status", FromMe: false},
			{ChatJID: newsletterJID, SenderJID: newsletterJID, MessageID: "NEWS_1", AgoSeconds: hours(2),
				Kind: "message", Text: "channel broadcast", FromMe: false},
		},
	}
}

// resolvedMessage is a fixture message with its absolute timestamp resolved
// against a fixed "now".
type resolvedMessage struct {
	msg FixtureMessage
	ts  time.Time
}

// resolve computes absolute timestamps for all messages relative to now.
func (f *Fixture) resolve(now time.Time) []resolvedMessage {
	out := make([]resolvedMessage, 0, len(f.Messages))
	for _, m := range f.Messages {
		out = append(out, resolvedMessage{msg: m, ts: now.Add(-time.Duration(m.AgoSeconds) * time.Second)})
	}
	return out
}

// chatLastActivity returns the most recent message timestamp per chat.
func (f *Fixture) chatLastActivity(resolved []resolvedMessage) map[string]time.Time {
	last := map[string]time.Time{}
	for _, rm := range resolved {
		if cur, ok := last[rm.msg.ChatJID]; !ok || rm.ts.After(cur) {
			last[rm.msg.ChatJID] = rm.ts
		}
	}
	return last
}

// actorByJID indexes actors for quick lookup.
func (f *Fixture) actorByJID() map[string]FixtureActor {
	m := map[string]FixtureActor{}
	for _, a := range f.Actors {
		m[a.JID] = a
	}
	return m
}

// chatByJID indexes chats for quick lookup.
func (f *Fixture) chatByJID() map[string]FixtureChat {
	m := map[string]FixtureChat{}
	for _, c := range f.Chats {
		m[c.JID] = c
	}
	return m
}

// selfActorJID returns the JID of the self actor, if any.
func (f *Fixture) selfActorJID() string {
	for _, a := range f.Actors {
		if a.IsSelf {
			return a.JID
		}
	}
	return ""
}

// canonJID canonicalizes a fixture JID string the same way the real daemon does
// (contract §R2.4, bug 7): strip any device suffix (":<n>" before "@"), map a
// "<lid>@lid" address to its phone-number JID via LIDMap, and collapse the self
// chat to the self PN. Bare phone-number JIDs pass through unchanged, so
// existing PN-only fixtures/tests are unaffected.
func (f *Fixture) canonJID(raw string) string {
	if raw == "" {
		return ""
	}
	user, server := splitJID(raw)
	user = stripDevice(user)

	self := f.canonSelfPN()

	switch server {
	case "g.us", "broadcast", "newsletter":
		return user + "@" + server
	case "lid":
		// Self LID -> self PN.
		if self != "" && raw == f.selfActorJID() {
			return self
		}
		if pn, ok := f.LIDMap[user]; ok && pn != "" {
			return canonPN(pn, self)
		}
		// Unknown LID: keep normalized (stable).
		return user + "@lid"
	default: // s.whatsapp.net (PN) and anything else
		pn := user + "@" + server
		return canonPN(pn, self)
	}
}

// canonPN collapses a PN JID to the self PN when it is the self chat.
func canonPN(pn, selfPN string) string {
	if selfPN != "" && pn == selfPN {
		return selfPN
	}
	return pn
}

// canonSelfPN returns the canonical self PN JID (device-stripped). Empty when
// the self actor is not phone-number addressed.
func (f *Fixture) canonSelfPN() string {
	self := f.selfActorJID()
	if self == "" {
		return ""
	}
	user, server := splitJID(self)
	if server != "s.whatsapp.net" {
		return "" // self addressed by LID in the fixture: no PN to collapse to
	}
	return stripDevice(user) + "@" + server
}

// skipMockChatJID mirrors the daemon's skipChatJID (contract §R4.3, bug 17):
// status@broadcast, @newsletter, and @broadcast JIDs are noise and must never
// produce channels or events. Normal @g.us groups and DM JIDs pass.
func skipMockChatJID(raw string) bool {
	_, server := splitJID(raw)
	switch server {
	case "broadcast", "newsletter":
		return true
	}
	return false
}

// isContentlessSystem mirrors the daemon's drop rule for contentless
// system/protocol events (contract §R4.3, bug 17): a system-kind message with
// no text and no media is dropped.
func isContentlessSystem(m FixtureMessage) bool {
	return m.Kind == "system" && m.Text == "" && m.Media == nil
}

// splitJID splits "user@server" into (user, server); server defaults to "".
func splitJID(jid string) (user, server string) {
	for i := 0; i < len(jid); i++ {
		if jid[i] == '@' {
			return jid[:i], jid[i+1:]
		}
	}
	return jid, ""
}

// stripDevice removes a ":<device>" (and any ".<agent>") suffix from a JID user
// part, mirroring JID.ToNonAD.
func stripDevice(user string) string {
	if i := indexByte(user, ':'); i >= 0 {
		user = user[:i]
	}
	if i := indexByte(user, '.'); i >= 0 {
		user = user[:i]
	}
	return user
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

var _ = protocol.KindMessage // keep protocol import used across build tags
