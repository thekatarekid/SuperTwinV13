package wa

import (
	"context"
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"

	"github.com/thekatarekid/supertwin/sources/whatsapp-go/internal/protocol"
)

// TestChannelBusinessFlag pins what marks a chat as a business (v3-spec §5). The
// worker gates media reads on this, so a false negative silently skips a chat's
// media and a false positive skips media the user expected to be read.
func TestChannelBusinessFlag(t *testing.T) {
	biz := mustJID(t, "919538251513@s.whatsapp.net")
	group := mustJID(t, "120363000000000001@g.us")

	tests := []struct {
		name string
		info types.MessageInfo
		want bool
	}{
		{
			name: "incoming dm with a verified-name certificate",
			info: verifiedNameInfo(t, biz, "", "JioHome"),
			want: true,
		},
		{
			name: "plain dm",
			info: types.MessageInfo{ID: "M1", MessageSource: types.MessageSource{Chat: biz, Sender: biz}},
		},
		{
			// WhatsApp's own accounts carry no certificate to prove it with, so they
			// are recognized by JID.
			name: "whatsapp's own official account",
			info: types.MessageInfo{
				ID:            "M1",
				MessageSource: types.MessageSource{Chat: mustJID(t, "0@s.whatsapp.net"), Sender: mustJID(t, "0@s.whatsapp.net")},
			},
			want: true,
		},
		{
			// A business posting into a group says nothing about the group.
			name: "group carrying a business sender's certificate",
			info: func() types.MessageInfo {
				info := verifiedNameInfo(t, group, "", "JioHome")
				info.IsGroup = true
				return info
			}(),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, _ := newTestEngine()
			_, ch, _, ok := e.mapMessage(tt.info, &waE2E.Message{Conversation: strp("Your OTP is 4821")})
			if !ok {
				t.Fatal("message must map")
			}
			if ch.IsBusiness != tt.want {
				t.Fatalf("channel is_business = %v, want %v", ch.IsBusiness, tt.want)
			}
		})
	}
}

// TestBusinessFlagSurvivesNameUpgrade proves the flag is carried on EVERY channel
// emission, not just the one that discovered it. A business proves itself once —
// one certificate, one BusinessName event — while the channel line is re-emitted
// each time a better name is learned.
func TestBusinessFlagSurvivesNameUpgrade(t *testing.T) {
	e, buf := newTestEngine()
	biz := mustJID(t, "919538251513@s.whatsapp.net")

	// First sight: the certificate names it and marks it a business.
	e.onMessage(&events.Message{
		Info:    verifiedNameInfo(t, biz, "", "JioHome"),
		Message: &waE2E.Message{Conversation: strp("OTP 4821")},
	})
	// A saved contact name arrives later and re-emits the channel.
	e.contactNameFn = func(types.JID) string { return "Jio Support" }
	e.onNameUpdate(biz, types.EmptyJID, "Jio Support")

	var flags []bool
	var names []string
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "channel" {
			continue
		}
		ch := line["channel"].(map[string]any)
		flags = append(flags, ch["is_business"].(bool))
		names = append(names, ch["name"].(string))
	}
	if len(flags) != 2 {
		t.Fatalf("emitted %d channel lines (%v), want the introduction plus the name upgrade", len(flags), names)
	}
	if !flags[0] || !flags[1] {
		t.Fatalf("is_business = %v across %v, want it on every emission", flags, names)
	}
}

// TestBusinessFlagReachesAnAlreadyNamedChat covers the ordering the flag is
// actually discovered in: a SAVED business is named by the contact store on its
// first message, so the verified-name certificate that proves it is a business
// arrives later and improves no name at all. The channel line carrying the flag
// has to go out anyway, or the worker's media gate reads a stale false forever.
func TestBusinessFlagReachesAnAlreadyNamedChat(t *testing.T) {
	e, buf := newTestEngine()
	biz := mustJID(t, "919538251513@s.whatsapp.net")
	e.contactNameFn = func(types.JID) string { return "Jio Support" }

	e.onMessage(&events.Message{
		Info:    types.MessageInfo{ID: "M1", MessageSource: types.MessageSource{Chat: biz, Sender: biz}},
		Message: &waE2E.Message{Conversation: strp("Hi")},
	})
	info := verifiedNameInfo(t, biz, "", "JioHome")
	info.ID = "M2"
	e.onMessage(&events.Message{Info: info, Message: &waE2E.Message{Conversation: strp("OTP 4821")}})

	var flag any
	var name any
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "channel" {
			continue
		}
		ch := line["channel"].(map[string]any)
		flag, name = ch["is_business"], ch["name"]
	}
	if flag != true {
		t.Fatalf("last channel line is_business = %v, want true once the certificate arrived", flag)
	}
	if name != "Jio Support" {
		t.Fatalf("last channel line name = %v, want the name already known", name)
	}
}

// TestBusinessNameEventMarksBusiness proves the BusinessName event alone
// classifies a chat: only a WABiz account has a business name at all.
func TestBusinessNameEventMarksBusiness(t *testing.T) {
	e, _ := newTestEngine()
	biz := mustJID(t, "919538251513@s.whatsapp.net")

	if e.businessChannel(biz) {
		t.Fatal("an unknown chat must not start out flagged as a business")
	}
	e.handleEvent(&events.BusinessName{JID: biz, NewBusinessName: "JioHome"})
	if !e.businessChannel(biz) {
		t.Fatal("a BusinessName event must mark the chat as a business")
	}
}

// TestVerifiedNameLookupMarksBusiness proves a USync verified-name recovery marks
// the chat too — USync only ever hands back a VERIFIED business name, so a hit is
// itself the proof.
func TestVerifiedNameLookupMarksBusiness(t *testing.T) {
	e, buf := newTestEngine()
	biz := mustJID(t, "919538251513@s.whatsapp.net")

	e.userInfoFn = func(_ context.Context, jids []types.JID) (map[types.JID]types.UserInfo, error) {
		return map[types.JID]types.UserInfo{}, nil
	}
	e.contactNameFn = func(types.JID) string { return "JioHome" }
	e.resolveUnsavedBusinessNames("test", []types.JID{biz})

	if !e.businessChannel(biz) {
		t.Fatal("a resolved verified name must mark the chat as a business")
	}
	found := false
	for _, line := range decodeLines(t, buf) {
		if line["t"] != "channel" {
			continue
		}
		found = true
		if ch := line["channel"].(map[string]any); ch["is_business"] != true {
			t.Errorf("recovered channel is_business = %v, want true", ch["is_business"])
		}
	}
	if !found {
		t.Fatal("the recovered business emitted no channel line")
	}
}

// TestGroupChannelNeverBusiness guards the other side: a group subject update
// re-emits the channel and must not pick up a business flag from anywhere.
func TestGroupChannelNeverBusiness(t *testing.T) {
	e, buf := newTestEngine()
	group := mustJID(t, "120363000000000001@g.us")

	id := group.String()
	e.emitWithMeta(
		&protocol.Channel{SourceExtID: id, Name: "Weekend Trip", Kind: "group"},
		nil,
		protocol.Event{ExternalID: id + "/M1", ChannelExtID: id, Kind: protocol.KindMessage},
	)
	e.onGroupNameUpdate(group, "Ski Trip 2027")

	for _, line := range decodeLines(t, buf) {
		if line["t"] != "channel" {
			continue
		}
		if ch := line["channel"].(map[string]any); ch["is_business"] != false {
			t.Errorf("group channel is_business = %v, want false", ch["is_business"])
		}
	}
}
