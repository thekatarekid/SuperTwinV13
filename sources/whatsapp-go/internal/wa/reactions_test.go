package wa

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/proto/waHistorySync"
	"go.mau.fi/whatsmeow/proto/waWeb"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

func u64p(v uint64) *uint64 { return &v }

// reactionKey builds a reaction's own MessageKey: the id names the REACTION, the
// participant names the reactor. Neither ever names the message reacted to.
func reactionKey(id, participant string, fromMe bool) *waCommon.MessageKey {
	k := &waCommon.MessageKey{FromMe: boolp(fromMe)}
	if id != "" {
		k.ID = strp(id)
	}
	if participant != "" {
		k.Participant = strp(participant)
	}
	return k
}

// TestReactionActor pins who a historical reaction is attributed to (v3-spec §4).
func TestReactionActor(t *testing.T) {
	chat := "15551234567@s.whatsapp.net"
	self := mustJID(t, "919999900000@s.whatsapp.net")

	tests := []struct {
		name   string
		key    *waCommon.MessageKey
		isDM   bool
		selfPN types.JID
		want   string
	}{
		{
			name: "group reaction names its participant",
			key:  reactionKey("RX1", "15559998888@s.whatsapp.net", false),
			want: "15559998888@s.whatsapp.net",
		},
		{
			name:   "our own reaction resolves to self",
			key:    reactionKey("RX2", "", true),
			isDM:   true,
			selfPN: self,
			want:   self.String(),
		},
		{
			// A DM has exactly two participants, so a reaction that isn't ours is
			// the peer's — whose JID IS the DM's channel id.
			name: "dm reaction with no participant is the peer",
			key:  reactionKey("RX3", "", false),
			isDM: true,
			want: chat,
		},
		{
			name: "group reaction with no participant is unattributable",
			key:  reactionKey("RX4", "", false),
		},
		{
			name: "our own reaction with no self identity is unattributable",
			key:  reactionKey("RX5", "", true),
			isDM: true,
		},
		{
			name: "a participant that is not a jid is ignored",
			key:  reactionKey("RX6", "not a jid", false),
			isDM: true,
			want: chat,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := &canonicalizer{selfPN: tt.selfPN}
			if got := reactionActor(c, tt.key, chat, tt.isDM); got != tt.want {
				t.Fatalf("reactionActor() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestSyntheticReactionIDStable proves a reaction whose key carries no id still
// gets a REPRODUCIBLE external id — without it, every re-import would insert the
// same reaction again under a fresh id.
func TestSyntheticReactionIDStable(t *testing.T) {
	chat := "15551234567@s.whatsapp.net"
	target := chat + "/MSG1"
	actor := "15559998888@s.whatsapp.net"

	first := syntheticReactionID(chat, target, actor, "👍")
	if first != syntheticReactionID(chat, target, actor, "👍") {
		t.Fatal("the same reaction must derive the same id on every import")
	}
	for _, other := range []string{
		syntheticReactionID(chat, chat+"/MSG2", actor, "👍"),
		syntheticReactionID(chat, target, "15550000000@s.whatsapp.net", "👍"),
		syntheticReactionID(chat, target, actor, "❤️"),
	} {
		if other == first {
			t.Fatalf("a different target/reactor/emoji must derive a different id; both were %q", first)
		}
	}
	if got := first[:len(chat)+4]; got != chat+"/rx-" {
		t.Fatalf("synthetic id = %q, want it namespaced under the chat", first)
	}
}

// TestEmitHistoryReactions is the core §4 proof: the reactions hanging off an
// imported message's WebMessageInfo become their own events, targeting the
// ENCLOSING message rather than their own key.
func TestEmitHistoryReactions(t *testing.T) {
	chat := "15551234567@s.whatsapp.net"
	at := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

	tests := []struct {
		name      string
		group     bool
		reactions []*waWeb.Reaction
		wantIDs   []string
		wantTexts []string
		wantActor []string
	}{
		{
			name: "dm reaction targets the enclosing message",
			reactions: []*waWeb.Reaction{{
				Key:               reactionKey("RX1", "", false),
				Text:              strp("👍"),
				SenderTimestampMS: i64p(at.UnixMilli()),
			}},
			wantIDs:   []string{chat + "/RX1"},
			wantTexts: []string{"👍"},
			wantActor: []string{chat},
		},
		{
			// Empty text is a REMOVED reaction, which the worker already handles.
			name: "removal is emitted, not dropped",
			reactions: []*waWeb.Reaction{{
				Key:               reactionKey("RX2", "", false),
				Text:              strp(""),
				SenderTimestampMS: i64p(at.UnixMilli()),
			}},
			wantIDs:   []string{chat + "/RX2"},
			wantTexts: []string{""},
			wantActor: []string{chat},
		},
		{
			name:  "group reactions are attributed per participant",
			group: true,
			reactions: []*waWeb.Reaction{
				{Key: reactionKey("RX3", "15559998888@s.whatsapp.net", false), Text: strp("🎉"), SenderTimestampMS: i64p(at.UnixMilli())},
				{Key: reactionKey("RX4", "15557776666@s.whatsapp.net", false), Text: strp("❤️"), SenderTimestampMS: i64p(at.UnixMilli())},
			},
			wantIDs:   []string{"120363000000000001@g.us/RX3", "120363000000000001@g.us/RX4"},
			wantTexts: []string{"🎉", "❤️"},
			wantActor: []string{"15559998888@s.whatsapp.net", "15557776666@s.whatsapp.net"},
		},
		{
			// Unattributable: a group reaction with no participant would be collapsed
			// onto the wrong actor, so it is dropped rather than guessed.
			name:      "unattributable group reaction is dropped",
			group:     true,
			reactions: []*waWeb.Reaction{{Key: reactionKey("RX5", "", false), Text: strp("👍"), SenderTimestampMS: i64p(at.UnixMilli())}},
		},
		{name: "no reactions emits nothing"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, buf := newTestEngine()
			chatJID := mustJID(t, chat)
			if tt.group {
				chatJID = mustJID(t, "120363000000000001@g.us")
			}
			parsed := &events.Message{
				Info: types.MessageInfo{
					ID:            "MSG1",
					Timestamp:     at,
					MessageSource: types.MessageSource{Chat: chatJID, Sender: chatJID, IsGroup: tt.group},
				},
				SourceWebMsg: &waWeb.WebMessageInfo{Reactions: tt.reactions},
			}
			ev := protocol.Event{
				ExternalID:   chatJID.String() + "/MSG1",
				ChannelExtID: chatJID.String(),
			}
			e.emitHistoryReactions(e.newCanonicalizer(), parsed, ev, protocol.RangeAll, at)

			var got []map[string]any
			for _, line := range decodeLines(t, buf) {
				if line["t"] == "event" {
					got = append(got, line["event"].(map[string]any))
				}
			}
			if len(got) != len(tt.wantIDs) {
				t.Fatalf("emitted %d reaction events, want %d (%v)", len(got), len(tt.wantIDs), got)
			}
			for i, rev := range got {
				if rev["kind"] != string(protocol.KindReaction) {
					t.Errorf("event %d kind = %v, want reaction", i, rev["kind"])
				}
				if rev["external_id"] != tt.wantIDs[i] {
					t.Errorf("event %d external_id = %v, want %q", i, rev["external_id"], tt.wantIDs[i])
				}
				if rev["text"] != tt.wantTexts[i] {
					t.Errorf("event %d text = %v, want %q", i, rev["text"], tt.wantTexts[i])
				}
				if rev["actor_ext_id"] != tt.wantActor[i] {
					t.Errorf("event %d actor_ext_id = %v, want %q", i, rev["actor_ext_id"], tt.wantActor[i])
				}
				// The target is the ENCLOSING message, never the reaction's own key.
				if rev["reply_to_external_id"] != ev.ExternalID {
					t.Errorf("event %d reply_to_external_id = %v, want the enclosing message %q", i, rev["reply_to_external_id"], ev.ExternalID)
				}
			}
		})
	}
}

// TestHistoryReactionRangeFilter proves a reaction is filtered by the same window
// as the messages, so an import cannot smuggle in activity outside the range the
// user picked.
func TestHistoryReactionRangeFilter(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	chat := mustJID(t, "15551234567@s.whatsapp.net")

	tests := []struct {
		name     string
		reactAt  time.Time
		wantKept bool
	}{
		{name: "inside the window", reactAt: now.Add(-2 * time.Hour), wantKept: true},
		{name: "outside the window", reactAt: now.Add(-10 * 24 * time.Hour)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, buf := newTestEngine()
			parsed := &events.Message{
				Info: types.MessageInfo{
					ID:            "MSG1",
					Timestamp:     now.Add(-time.Hour),
					MessageSource: types.MessageSource{Chat: chat, Sender: chat},
				},
				SourceWebMsg: &waWeb.WebMessageInfo{Reactions: []*waWeb.Reaction{{
					Key:               reactionKey("RX1", "", false),
					Text:              strp("👍"),
					SenderTimestampMS: i64p(tt.reactAt.UnixMilli()),
				}}},
			}
			ev := protocol.Event{ExternalID: chat.String() + "/MSG1", ChannelExtID: chat.String()}
			e.emitHistoryReactions(e.newCanonicalizer(), parsed, ev, protocol.Range7d, now)

			kept := false
			for _, line := range decodeLines(t, buf) {
				if line["t"] == "event" {
					kept = true
				}
			}
			if kept != tt.wantKept {
				t.Fatalf("reaction kept = %v, want %v", kept, tt.wantKept)
			}
		})
	}
}

// TestHistoryReactionTimestampFallback proves a reaction with no timestamp of its
// own inherits the message it sits on, so it lands in the same import window
// instead of at the unix epoch.
func TestHistoryReactionTimestampFallback(t *testing.T) {
	now := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	msgAt := now.Add(-time.Hour)
	chat := mustJID(t, "15551234567@s.whatsapp.net")

	e, buf := newTestEngine()
	parsed := &events.Message{
		Info: types.MessageInfo{
			ID:            "MSG1",
			Timestamp:     msgAt,
			MessageSource: types.MessageSource{Chat: chat, Sender: chat},
		},
		SourceWebMsg: &waWeb.WebMessageInfo{Reactions: []*waWeb.Reaction{{
			Key:  reactionKey("RX1", "", false),
			Text: strp("👍"),
		}}},
	}
	ev := protocol.Event{ExternalID: chat.String() + "/MSG1", ChannelExtID: chat.String()}
	e.emitHistoryReactions(e.newCanonicalizer(), parsed, ev, protocol.Range7d, now)

	var ts any
	for _, line := range decodeLines(t, buf) {
		if line["t"] == "event" {
			ts = line["event"].(map[string]any)["ts"]
		}
	}
	if ts != protocol.FormatTime(msgAt) {
		t.Fatalf("reaction ts = %v, want the enclosing message's %q", ts, protocol.FormatTime(msgAt))
	}
}

// TestHistoryLoopEmitsReactions is the regression proof for the ONE line that
// caused every old reaction to vanish: the history loop dropped SourceWebMsg, so
// the reactions on an imported message never reached the protocol at all.
func TestHistoryLoopEmitsReactions(t *testing.T) {
	at := time.Now().Add(-time.Hour)
	chat := "15551234567@s.whatsapp.net"

	e, buf := newTestEngine()
	// Stand in for client.ParseWebMessage, keeping SourceWebMsg attached exactly
	// as whatsmeow does.
	e.parseWebMsgFn = func(c types.JID, webMsg *waWeb.WebMessageInfo) (*events.Message, error) {
		return &events.Message{
			Info: types.MessageInfo{
				ID:            webMsg.GetKey().GetID(),
				Timestamp:     at,
				MessageSource: types.MessageSource{Chat: c, Sender: c},
			},
			Message:      &waE2E.Message{Conversation: strp("dinner at 8?")},
			SourceWebMsg: webMsg,
		}, nil
	}
	e.SetRange(protocol.Range7d)

	webMsg := &waWeb.WebMessageInfo{
		Key:              &waCommon.MessageKey{ID: strp("MSG1"), RemoteJID: strp(chat)},
		MessageTimestamp: u64p(uint64(at.Unix())),
		Reactions: []*waWeb.Reaction{{
			Key:               reactionKey("RX1", "", false),
			Text:              strp("👍"),
			SenderTimestampMS: i64p(at.UnixMilli()),
		}},
	}
	e.processHistorySync(&events.HistorySync{Data: &waHistorySync.HistorySync{
		SyncType: waHistorySync.HistorySync_RECENT.Enum(),
		Conversations: []*waHistorySync.Conversation{{
			ID:               strp(chat),
			LastMsgTimestamp: u64p(uint64(at.Unix())),
			Messages:         []*waHistorySync.HistorySyncMsg{{Message: webMsg}},
		}},
	}})

	var kinds []string
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "event" {
			continue
		}
		kinds = append(kinds, line["event"].(map[string]any)["kind"].(string))
	}
	want := []string{string(protocol.KindMessage), string(protocol.KindReaction)}
	if len(kinds) != len(want) || kinds[0] != want[0] || kinds[1] != want[1] {
		t.Fatalf("history emitted %v, want the message followed by its reaction %v", kinds, want)
	}
}
